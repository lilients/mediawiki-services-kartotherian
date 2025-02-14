'use strict';

const preq = require( 'preq' );
const assert = require( '../../utils/assert' );
const Server = require( '../../utils/server' );

const server = new Server();

describe( 'service information', () => {
	jest.setTimeout( 20000 );

	let infoUri;

	beforeAll( async () => {
		await server.start();
		infoUri = `${server.config.uri}_info/`;
	} );

	afterAll( () => {
		server.stop();
	} );

	// common URI prefix for info tests

	// common function used for generating requests
	// and checking their return values
	function checkRet( fieldName ) {
		return preq.get( {
			uri: infoUri + fieldName
		} ).then( ( res ) => {
			// check the returned Content-Type header
			assert.contentType( res, 'application/json' );
			// the status as well
			assert.status( res, 200 );
			// finally, check the body has the specified field
			assert.notDeepEqual( res.body, undefined, 'No body returned!' );
			assert.notDeepEqual( res.body[ fieldName ], undefined, `No ${fieldName} field returned!` );
		} );
	}

	it( 'should get the service name', () => checkRet( 'name' ) );

	it( 'should get the service version', () => checkRet( 'version' ) );

	it( 'should redirect to the service home page', () => preq.get( {
		uri: `${infoUri}home`,
		followRedirect: false
	} ).then( ( res ) => {
		// check the status
		assert.status( res, 301 );
	} ) );

	it( 'should get the service info', () => preq.get( {
		uri: infoUri
	} ).then( ( res ) => {
		// check the status
		assert.status( res, 200 );
		// check the returned Content-Type header
		assert.contentType( res, 'application/json' );
		// inspect the body
		assert.notDeepEqual( res.body, undefined, 'No body returned!' );
		assert.notDeepEqual( res.body.name, undefined, 'No name field returned!' );
		assert.notDeepEqual( res.body.version, undefined, 'No version field returned!' );
		assert.notDeepEqual( res.body.description, undefined, 'No description field returned!' );
		assert.notDeepEqual( res.body.home, undefined, 'No home field returned!' );
	} ) );
} );
