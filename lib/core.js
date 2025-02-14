'use strict';

const _ = require( 'underscore' );
const Promise = require( 'bluebird' );
const zlib = require( 'zlib' );
const qidx = require( 'quadtile-index' );
const uptile = require( 'tilelive-promise' );
const toBuffer = require( 'typedarray-to-buffer' );
const checkType = require( './input-validator' );
const Err = require( './err' );

Promise.promisifyAll( zlib );

// Make sure there is String.endsWith()
if ( !String.prototype.endsWith ) {
	// eslint-disable-next-line no-extend-native
	String.prototype.endsWith = function endsWith( searchString, position ) {
		const subjectString = this.toString();
		if ( position === undefined || position > subjectString.length ) {
			position = subjectString.length;
		}
		position -= searchString.length;
		const lastIndex = subjectString.indexOf( searchString, position );
		return lastIndex !== -1 && lastIndex === position;
	};
}

const core = {};
module.exports = core;

let _app;
let _packageConfig;
let _rootDir;
let _npmLoader;
let _npmResolver;
let _sources;

/**
 * Initializes the core
 *
 * @param {Object} app main object from service-runner
 * @param {Object} app.conf configuration object defined in the config.yaml file
 * @param {Object} app.logger logger object that implements log(group, message) function
 * @param {Object} app.metrics object to send metrics data to
 * @param {Object} packageConfig configuration object defined in the package.json kartotherian tag
 * @param {string} rootDir Absolute path of the root directory of the main app
 * @param {Function} npmLoader function that performs 'require(moduleName)'
 *   in the context of the main app
 * @param {Function} npmResolver function that performs 'require.resolve(moduleName)'
 *   in the context of the main app
 *
 * TODO: Any suggestions about how to get rid of this ugly hack are welcome
 *
 */
core.init = function init( app, packageConfig, rootDir, npmLoader, npmResolver ) {
	_app = app;
	_packageConfig = packageConfig;
	_rootDir = rootDir;
	_npmLoader = npmLoader;
	_npmResolver = npmResolver;

	core.log = app.logger.log.bind( app.logger );
	core.metrics = app.metrics;

	const tilelive = npmLoader( '@mapbox/tilelive' );
	Promise.promisifyAll( tilelive );
	core.tilelive = tilelive;

	const mapnik = npmLoader( '@kartotherian/mapnik' );
	Promise.promisifyAll( mapnik.Map.prototype );
	Promise.promisifyAll( mapnik.VectorTile.prototype );
	Promise.promisifyAll( mapnik.Image );
	Promise.promisifyAll( mapnik.Image.prototype );

	mapnik.register_default_fonts();
	mapnik.register_system_fonts();
	mapnik.register_default_input_plugins();

	core.mapnik = mapnik;
};

/**
 * Registers a tilelive.js or kartotherian module with the tilelive
 *
 * @param {string} moduleName
 */
core.registerTileliveModule = function registerTileliveModule( moduleName ) {
	if ( !core._registeredModules ) {
		core._registeredModules = {};
	}
	if ( !core._registeredModules[ moduleName ] ) {
		core._registeredModules[ moduleName ] = true;

		const module = _npmLoader( moduleName );
		if ( module.initKartotherian ) {
			module.initKartotherian( core );
		} else if ( module.registerProtocols ) {
			module.registerProtocols( core.tilelive );
		} else if ( typeof module === 'function' ) {
			module( core.tilelive );
		} else {
			throw new Err( 'Unable to load a non-tilelive module %j', moduleName );
		}
	}
};

/**
 * Log info - will get overriden during init() call
 */
core.log = function log() {
	console.log.apply( null, arguments );
};

/**
 * Attempt to convert Error to anything printable (with stacktrace)
 *
 * @param {Object|string} err
 * @return {string}
 */
core.errToStr = function errToStr( err ) {
	return ( err.body && ( err.body.stack || err.body.detail ) ) || err.stack || err;
};

/**
 * Performs 'require()' in the context of the main app
 *
 * @param {string} moduleName
 * @return {*}
 */
core.resolveModule = function resolveModule( moduleName ) {
	if ( !_npmResolver ) {
		throw new Err( 'core.init() has not been called' );
	}
	return _npmResolver( moduleName );
};

/**
 * Returns the root dir of the app, as specified in the init() call
 *
 * @return {string}
 */
core.getAppRootDir = function getAppRootDir() {
	if ( !_rootDir ) {
		throw new Err( 'core.init() has not been called' );
	}
	return _rootDir;
};

/**
 * @param {string} pkgConfigList
 * @return {Array}
 */
core.loadNpmModules = function loadNpmModules( pkgConfigList ) {
	return _.map( core.getAppConfiguration()[ pkgConfigList ], ( lib ) => _npmLoader( lib ) );
};

/**
 * Throw "standard" tile does not exist error.
 * The error message string is often used to check if tile existance, so it has to be exact
 */
core.throwNoTile = function throwNoTile() {
	throw new Error( 'Tile does not exist' );
};

/**
 * Checks if the error indicates the tile does not exist
 *
 * @param {{message: string}} err
 * @return {boolean}
 */
core.isNoTileError = function isNoTileError( err ) {
	return err.message === 'Tile does not exist';
};

const contentEncoderRe = /^content-encoding$/i;

core.uncompressAsync = Promise.method( ( data, headers ) => {
	if ( data && data.length ) {
		const useUnzip = data[ 0 ] === 0x1F && data[ 1 ] === 0x8B;
		const useInflate = !useUnzip && data[ 0 ] === 0x78 && data[ 1 ] === 0x9C;
		if ( useUnzip || useInflate ) {
			if ( headers ) {
				// remove Content-Encoding header (might be different case)
				for ( const key of Object.keys( headers ) ) {
					if ( contentEncoderRe.test( key ) ) {

						delete headers[ key ];
					}
				}
			}
			if ( useUnzip ) {
				return zlib.gunzipAsync( data );
			}
			return zlib.inflateAsync( data );
		}
	}
	return data;
} );

/**
 * Extract portion of a higher zoom tile as a new tile
 *
 * @param {*} baseTileRawPbf uncompressed vector tile pbf
 * @param {number} z desired zoom of the sub-tile
 * @param {number} x sub-tile's x
 * @param {number} y sub-tile's y
 * @param {number} bz source tile's zoom
 * @param {number} bx source tile's x
 * @param {number} by source tile's y
 * @return {Promise}
 */
core.extractSubTileAsync = function extractSubTileAsync( baseTileRawPbf, z, x, y, bz, bx, by ) {
	return Promise
		.try( () => {
			if ( bz >= z ) {
				throw new Err( 'Base tile zoom is not less than z' );
			}
			const baseTile = new core.mapnik.VectorTile( bz, bx, by );
			// TODO: setData has an async version - we might want to use it instead
			baseTile.setData( baseTileRawPbf );
			const subTile = new core.mapnik.VectorTile( +z, +x, +y );
			// TODO: should we do a ".return(subTile)" after compositeAsync()?
			return subTile.compositeAsync( [ baseTile ] );
		} ).then( ( tile ) => tile.getData() );
};

/**
 * @param {*} data
 * @param {Object} headers
 * @return {Promise}
 * @deprecated Use core.compressPbfAsync
 */
core.compressPbfAsync2 = function compressPbfAsync2( data, headers ) {
	if ( !data || data.length === 0 ) {
		return [ data, headers ];
	}
	if ( !( data instanceof Buffer ) ) {
		// gzip does not handle typed buffers like Uint8Array

		data = toBuffer( data );
	}
	return zlib
		.gzipAsync( data )
		.then( ( pbfz ) => {

			headers[ 'Content-Encoding' ] = 'gzip';
			return [ pbfz, headers ];
		} );
};

core.compressPbfAsync = function compressPbfAsync( result ) {
	if ( !result.data || result.data.length === 0 ) {
		return result;
	}
	if ( !( result.data instanceof Buffer ) ) {
		// gzip does not handle typed buffers like Uint8Array

		result.data = toBuffer( result.data );
	}
	return zlib
		.gzipAsync( result.data )
		.then( ( pbfz ) => {

			result.data = pbfz;

			result.headers[ 'Content-Encoding' ] = 'gzip';
			return result;
		} );
};

/**
 * Wrapper around the backwards-style getTile() call,
 * where extra args are passed by attaching them to the callback
 *
 * @param {Object} source
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @param {Object} opts
 * @return {Promise}
 */
core.getTitleWithParamsAsync = function getTitleWithParamsAsync( source, z, x, y, opts ) {
	return new Promise( ( resolve, reject ) => {
		try {
			const callback = ( err, data, headers ) => {
				if ( err ) {
					reject( err );
				} else {
					resolve( [ data, headers ] );
				}
			};
			source.getTile( z, x, y, opts ? _.extend( callback, opts ) : callback );
		} catch ( err ) {
			reject( err );
		}
	} );
};

core.loadSource = function loadSource( sourceUri ) {
	return core.tilelive.loadAsync( sourceUri ).then( ( handler ) => {
		if ( !handler ) {
			const protocol = JSON.stringify( ( _.isObject( sourceUri ) ?
				sourceUri.protocol || 'unknown' :
				sourceUri ).split( ':', 1 )[ 0 ] );
			throw new Err( `Tilelive handler for ${protocol} failed to instantiate` );
		}

		// Annoyingly, Tilesource API has a few functions that break the typical NodeJS callback
		// pattern of function(error, result), and instead have multiple results.  For them,
		// we need to promisify them with the { multiArgs: true }
		// API:  https://github.com/mapbox/tilelive/blob/master/API.md
		// See also: http://bluebirdjs.com/docs/api/promise.promisifyall.html#option-multiargs
		Promise.promisifyAll( handler, {
			filter( name ) {
				return name === 'getTile' || name === 'getGrid';
			},
			multiArgs: true
		} );
		// Promisify the rest of the methods
		Promise.promisifyAll( handler );

		// Inject getAsync()
		uptile( handler );

		return handler;
	} );
};

core.validateZoom = function validateZoom( zoom, source ) {
	zoom = checkType.strToInt( zoom );
	if ( !qidx.isValidZoom( zoom ) ) {
		throw new Err( 'invalid zoom' ).metrics( 'err.req.coords' );
	}
	if ( source.minzoom !== undefined && zoom < source.minzoom ) {
		throw new Err( 'Minimum zoom is %d', source.minzoom ).metrics( 'err.req.zoom' );
	}
	if ( source.maxzoom !== undefined && zoom > source.maxzoom ) {
		throw new Err( 'Maximum zoom is %d', source.maxzoom ).metrics( 'err.req.zoom' );
	}
	return zoom;
};

core.validateScale = function validateScale( scale, source ) {
	if ( scale !== undefined ) {
		if ( !source.scales ) {
			throw new Err( 'Scaling is not enabled for this source' ).metrics( 'err.req.scale' );
		}
		if ( !_.contains( source.scales, scale.toString() ) ) {
			throw new Err(
				'This scaling is not allowed for this source. Allowed: %j',
				source.scales.join()
			).metrics( 'err.req.scale' );
		}

		scale = parseFloat( scale );
	}
	return scale;
};

core.reportError = function reportError( errReporterFunc, err ) {
	try {
		errReporterFunc( err );
	} catch ( e2 ) {
		console.error( `Unable to report: ${
			core.errToStr( err )
		}\n\nDue to: ${core.errToStr( e2 )}` );
	}
};

core.reportRequestError = function reportRequestError( err, res ) {
	// TODO: Fix this shadow properly
	// eslint-disable-next-line no-shadow
	core.reportError( ( err ) => {
		res
			.status( 400 )
			.header( 'Cache-Control', 'public, s-maxage=30, max-age=30' )
			.json( err.message || 'error/unknown' );
		// Any error that has metrics setting does not need to go into the error log
		core.log( core.areMetricsValid( err.metrics ) ? 'info' : 'error', err );
		core.metrics.increment( ( core.areMetricsValid( err.metrics ) && err.metrics ) || 'err.unknown' );
	}, err );
};

// Prevent metrics to be sent if it's a function (T212303)
core.areMetricsValid = function areMetricsValid( metrics ) {
	return typeof metrics === 'string';
};

core.getAppConfiguration = function getAppConfiguration() {
	return _packageConfig;
};

core.getConfiguration = function getConfiguration() {
	return _app.conf;
};

core.setSources = function setSources( sources ) {
	_sources = sources;
};

core.getSources = function getSources() {
	if ( !_sources ) {
		throw new Err( 'The service has not started yet' );
	}
	return _sources;
};

core.getPublicSource = function getPublicSource( srcId ) {
	const source = core.getSources().getSourceById( srcId, true );
	if ( !source ) {
		throw new Err( 'Unknown source' ).metrics( 'err.req.source' );
	}
	if ( !source.public && !core.getConfiguration().allSourcesPublic ) {
		throw new Err( 'Source is not public' ).metrics( 'err.req.source' );
	}
	return source;
};

/**
 * Set headers on the response object
 *
 * @param {Object} res
 * @param {Object} source
 * @param {Object} dataHeaders
 */
core.setResponseHeaders = function setResponseHeaders( res, source, dataHeaders ) {
	const conf = core.getConfiguration();
	if ( conf.defaultHeaders ) {
		res.set( conf.defaultHeaders );
	}
	if ( source && source.defaultHeaders ) {
		res.set( source.defaultHeaders );
	}
	if ( dataHeaders ) {
		res.set( dataHeaders );
	}
	if ( conf.overrideHeaders ) {
		res.set( conf.overrideHeaders );
	}
	if ( source && source.headers ) {
		res.set( source.headers );
	}
};

core.Sources = require( './sources' );
