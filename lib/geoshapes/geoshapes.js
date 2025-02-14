'use strict';

const topojson = require( 'topojson' );
const Err = require( '../err' );
const preq = require( 'preq' );
const parseWikidataValue = require( 'wd-type-parser' );

const simpleStyleProperties = {
	fill_opacity: 'fill-opacity',
	marker_color: 'marker-color',
	marker_size: 'marker-size',
	marker_symbol: 'marker-symbol',
	stroke_opacity: 'stroke-opacity',
	stroke_width: 'stroke-width'
};

const floatRegex = /-?[0-9]+(\.[0-9]+)?/;

class GeoShapes {
	/**
	 * @param {string} type "geoshape" or "geopoint"
	 * @param {Object} reqParams
	 * @param {string} [reqParams.ids]
	 * @param {string} [reqParams.query]
	 * @param {string} [reqParams.idcolumn] defaults to "id"
	 * @param {string} reqParams.sql Key for a query in `config.queries`, e.g. "simplifyarea"
	 * @param {Object} config
	 * @param {number} config.maxidcount maximum number of ids in `reqParams.ids`, e.g. 500
	 * @param {string} config.wikidataQueryService
	 * @param {Object} config.sparqlHeaders additional headers, e.g. for a User-Agent
	 * @param {string} config.coordinatePredicateId e.g. "wdt:P625"
	 * @param {pgPromise} config.db
	 * @param {Object} config.queries
	 * @param {string} config.lineTable e.g."wikidata_relation_members"
	 * @param {string} config.polygonTable e.g. "wikidata_relation_polygon"
	 * @param {string} config.mwapi e.g. "https://en.wikipedia.org/w/api.php"
	 * @param {Object} config.mwapiHeaders additional headers, e.g. for a User-Agent
	 */
	constructor( type, reqParams, config ) {
		this.config = config;

		this.type = type;
		this.defaultIdColumn = 'id';
		this.geoColumn = 'geo';
		this.reqParams = reqParams;
		this.db = config.db;
		this.coordinatePredicateId = config.coordinatePredicateId;

		// Temporary destructuring assignment.
		( {
			sparqlQuery: this.sparqlQuery,
			ids: this.ids,
			idColumn: this.idColumn,
			useGeoJson: this.useGeoJson,
			queryName: this.queryName
		} = this._parseParams( reqParams ) );
	}

	/**
	 *
	 * @param {Object} reqParams
	 * @param {string} [reqParams.ids]
	 * @param {string} [reqParams.query]
	 * @param {string} [reqParams.idcolumn] defaults to "id"
	 * @param {string} [reqParams.sql] Key for a query in `config.queries`, e.g. "simplifyarea"
	 * @return {Object} Normalized request parameters
	 */
	_parseParams( reqParams ) {
		if ( !reqParams.ids && !reqParams.query ) { throw new Err( '"ids" or "query" parameter must be given' ); }
		if ( reqParams.query && !this.config.wikidataQueryService ) { throw new Err( '"query" parameter is not enabled' ); }

		const ids = new Set( reqParams.ids ? reqParams.ids.split( ',' ) : [] );
		ids.delete( '' );
		if ( ids.size > this.config.maxidcount ) {
			throw new Err( 'Not more than %d ids allowed', this.config.maxidcount );
		}
		ids.forEach( ( id ) => {
			if ( !/^Q[1-9][0-9]{0,15}$/.test( id ) ) {
				throw new Err( 'Invalid Wikidata id "%s"', id );
			}
		} );

		return {
			sparqlQuery: reqParams.query,
			ids: [ ... ids ],
			idColumn: reqParams.idcolumn,
			useGeoJson: !!reqParams.getgeojson,
			queryName: reqParams.sql
		};
	}

	/**
	 * Main execution method
	 *
	 * @param {string} [xClientIp]
	 * @param {Object} [metrics]
	 * @return {Object}
	 */
	async execute( xClientIp, metrics ) {
		const start = Date.now();

		const rawProperties = await this._runWikidataQuery(
			this.type, this.sparqlQuery, this.ids, this.idColumn, xClientIp
		);
		const queriedIds = rawProperties.map( ( row ) => row.id );
		const allIds = new Set( [ ...this.ids, ...queriedIds ] );
		const [ geoRows, cleanProperties ] = await Promise.all( [
			this._runSqlQuery( this.type, [ ...allIds ], this.queryName, this.reqParams ),
			this._expandProperties( rawProperties )
		] );

		const result = await this._wrapResult(
			this.type, geoRows, cleanProperties, this.useGeoJson
		);

		if ( metrics ) {
			const metric = this.type + ( this.sparqlQuery ? '.wdqs' : '.ids' );
			metrics.endTiming( metric, start );
		}
		return result;
	}

	/**
	 *
	 * @param {string} type
	 * @param {string|undefined} query
	 * @param {string[]} ids
	 * @param {string|undefined} customIdColumn
	 * @param {string} [xClientIp]
	 * @return {Object[]}
	 */
	async _runWikidataQuery( type, query, ids, customIdColumn, xClientIp ) {
		// If there is no query, we only use the ids given in the request
		if ( !query && ids.length && type === 'geopoint' ) {
			query = this._createPointsSparqlQuery( ids );
		}
		if ( !query ) { return []; }

		const queryResult = await preq.get( {
			uri: this.config.wikidataQueryService,
			query: {
				format: 'json',
				query
			},
			headers: Object.assign( this.config.sparqlHeaders, { 'X-Client-IP': xClientIp } )

		} );
		if ( !queryResult.headers[ 'content-type' ].startsWith( 'application/sparql-results+json' ) ) {
			throw new Err( 'Unexpected content type %s', queryResult.headers[ 'content-type' ] );
		}
		const data = queryResult.body;
		if ( !data.results || !Array.isArray( data.results.bindings ) ) {
			throw new Err( 'SPARQL query result does not have "results.bindings"' );
		}

		return data.results.bindings.map(
			( wd ) => this._processResultRow( wd, customIdColumn )
		);
	}

	/**
	 *
	 * @param {string[]} ids
	 * @return {string} SPARQL query
	 */
	_createPointsSparqlQuery( ids ) {
		const formattedIds = ids.map( ( id ) => 'wd:' + id ).join( ' ' );
		return 'SELECT ?id ?geo WHERE { VALUES ?id { ' + formattedIds + ' } ?id ' + this.coordinatePredicateId + ' ?geo }';
	}

	/**
	 * Handle one wikidata query result row
	 *
	 * Normalize and validate the id to a simple string value and store in the
	 * `id` property.  Normalize a coordinate into the `coordinate` property.
	 *
	 * @param {Object} wd
	 * @param {string} [customIdColumn]
	 * @return {Object}
	 */
	_processResultRow( wd, customIdColumn ) {
		const idColumn = customIdColumn || this.defaultIdColumn;
		if ( !( idColumn in wd ) ) {
			let errMsg = 'SPARQL query result does not contain %j column.';
			if ( !customIdColumn ) {
				errMsg += ' Use `idcolumn` argument to specify column name, or change the query to return `id` column.';
			}
			throw new Err( errMsg, idColumn );
		}
		const { [ idColumn ]: value, ...result } = wd;
		result.id = parseWikidataValue( value, true );
		if ( !result.id || value.type !== 'uri' ) {
			throw new Err( 'SPARQL query result id column %j is expected to be a valid Wikidata id', idColumn );
		}
		if ( wd[ this.geoColumn ] ) {
			result.coordinate = parseWikidataValue( wd[ this.geoColumn ], true );
		}

		// further parsing will be done later, once we know the object actually
		// exists in the OSM db
		return result;
	}

	/**
	 * Retrieve all geo shapes for the given list of ids from local database
	 *
	 * @param {string} type
	 * @param {string[]} ids
	 * @param {string} [queryKey]
	 * @param {Object} rawParams
	 * @return {Array}
	 */
	async _runSqlQuery( type, ids, queryKey, rawParams ) {
		if ( ids.length === 0 || type === 'geopoint' ) { return []; }
		const args = [ type === 'geoshape' ? this.config.polygonTable : this.config.lineTable, ids ];
		const query = this.config.queries[ queryKey ] || this.config.queries.default;

		if ( query.params ) {
			query.params.forEach( ( param ) => {
				const paramName = param.name;
				if ( !paramName || !rawParams[ paramName ] ) {
					// If param name is NOT defined, we always use default,
					// without allowing user to customize it
					args.push( param.default );
				} else {
					const value = rawParams[ paramName ];
					if ( floatRegex.test( value ) ) { throw new Err( 'Invalid value for param %s', paramName ); }
					args.push( value );
				}
			} );
		}

		return await this.db.query( query.sql, args );
	}

	/**
	 * @param {Object[]} rawProperties
	 * @return {Object[]|undefined}
	 */
	async _expandProperties( rawProperties ) {
		// Create fake geojson with the needed properties, and sanitize them via api
		// We construct valid GeoJSON with each property object in this form:
		// {
		//     "type": "Feature",
		//     "id": "...",
		//     "properties": {...},
		//     "geometry": {"type": "Point", "coordinates": [0,0]}
		// }
		const props = rawProperties.map( ( row ) => {
			const { id, ...prop } = row;
			const transformedProps = {};
			for ( let key in prop ) {
				const value = prop[ key ];
				if ( value ) {
					// If this is a simplestyle property with a '_' in the name instead of '-',
					// convert it to the proper syntax.
					// SPARQL is unable to produce columns with a '-' in the name.
					key = simpleStyleProperties[ key ] || key;
					transformedProps[ key ] = parseWikidataValue( value );
				}
			}
			return {
				type: 'Feature',
				id,
				properties: transformedProps,
				geometry: { type: 'Point', coordinates: [ 0, 0 ] }
			};
		} );

		if ( !props.length ) { return undefined; }

		const apiResult = await preq.post( {
			uri: this.config.mwapi,
			formData: {
				format: 'json',
				formatversion: 2,
				action: 'sanitize-mapdata',
				text: JSON.stringify( props )
			},
			headers: this.config.mwapiHeaders

		} );

		if ( apiResult.body.error ) { throw new Err( apiResult.body.error ); }
		const body = apiResult.body[ 'sanitize-mapdata' ];
		if ( !body ) {
			throw new Err( 'Unexpected api action=sanitize-mapdata results' );
		}
		if ( body.error ) { throw new Err( body.error ); }
		if ( !body.sanitized ) {
			throw new Err( 'Unexpected api action=sanitize-mapdata results' );
		}
		const sanitized = JSON.parse( body.sanitized );
		if ( !sanitized || !Array.isArray( sanitized ) ) {
			throw new Err( 'Unexpected api action=sanitize-mapdata sanitized value results' );
		}
		return sanitized.map( ( row ) => {
			return { ...row.properties, id: row.id };
		} );
	}

	/**
	 * @param {string} type
	 * @param {Array} rows
	 * @param {Object[]} properties
	 * @param {boolean} useGeoJson
	 * @return {Object}
	 */
	_wrapResult( type, rows, properties, useGeoJson ) {
		// If no result, return an empty result set - which greatly simplifies processing
		let features = [];

		if ( type === 'geopoint' && properties ) {
			features = properties.map( ( value ) => {
				const id = value.id;
				delete value[ this.idColumn ];
				delete value.id;
				const coordinates = value[ this.geoColumn ];
				delete value[ this.geoColumn ];

				return {
					type: 'Feature',
					id,
					properties: value,
					geometry: {
						type: 'Point',
						coordinates
					}
				};
			} );
		} else if ( rows ) {
			features = rows.map( ( row ) => {
				const feature = {
					type: 'Feature',
					id: row.id,
					properties: {},
					geometry: JSON.parse( row.data )
				};
				if ( properties ) {
					const wd = properties.find( ( props ) => row.id === props.id );
					if ( wd ) {
						feature.properties = wd;
						delete feature.properties.id;
					}
				}
				return feature;
			} );
		}

		// TODO: Would be good to somehow monitor the average/min/max number of features
		// core.metrics.count(geoshape.metric, features.length);

		const result = {
			type: 'FeatureCollection',
			features
		};
		if ( !useGeoJson ) {
			return topojson.topology( { data: result }, {
				// preserve all properties
				'property-transform': ( feature ) => feature.properties
			} );
		}
		return result;
	}
}

module.exports = GeoShapes;
