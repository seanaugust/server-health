'use strict';

const Promise = require('bluebird');
const assert = require('chai').assert;
const sinon = require('sinon');
const restify = require('restify');
const hapi = require('hapi');
const http = require('http');

const serverHealth = require('../lib/health');


describe('server health', () => {

  /**
   * Helper function to run requests against the health endpoint
   *
   * @param {string} [queryString] - optional query string
   * @return {Promise.<Object>} Resolves over the server response with parsed body
   */
  function getHealth(queryString) {
    let path = '/health';
    if (queryString) {
      path += '?' + queryString;
    }

    return new Promise((resolve, reject) => {
      http.get({
        host: 'localhost',
        port: 8080,
        path: path
      }, (response) => {
        let rawData = '';

        response.setEncoding('utf8');
        response.on('data', (chunk) => { rawData += chunk; });
        response.on('end', () => {
          try {
            response.body = JSON.parse(rawData);
            return resolve(response);
          } catch (err) {
            reject(err);
          }
        });

      }).on('error', (err) => {
        reject(err);
      });
    });
  }


  describe('exposeHealthEndpoint', () => {

    it('adds a health endpoint with restify', () => {
      const server = restify.createServer();
      serverHealth.exposeHealthEndpoint(server);

      assert.property(server.routes, 'gethealth');
    });

    it('adds a health endpoint with hapi', () => {
      const server = new hapi.Server();
      server.connection({ port: 8080, host: 'localhost' });
      serverHealth.exposeHealthEndpoint(server, '/health', 'hapi');

      const hasHealthRoute = server.table()[0].table.some(({ path }) => path === '/health');
      assert.isTrue(hasHealthRoute);
    });

  });

  const servers = [
    {
      _server: null,
      name: 'restify',
      start(done) {
        this._server = restify.createServer();
        this._server.use(restify.plugins.queryParser());
        serverHealth.exposeHealthEndpoint(this._server);
        this._server.listen(8080, done);
      },
      stop(done) {
        this._server.close(done);
      },
    },
    {
      _server: null,
      name: 'hapi',
      start(done) {
        this._server = new hapi.Server();
        this._server.connection({ port: 8080, host: 'localhost' });
        serverHealth.exposeHealthEndpoint(this._server, '/health', 'hapi');
        this._server.start(done);
      },
      stop(done) {
        this._server.stop(done);
      },
    },
  ];

  for (const server of servers) {
    describe(`healthHandler for ${server.name}`, () => {

      let checkStubOne;
      let checkStubTwo;

      beforeEach(function setupServer(done) {
        checkStubOne = sinon.stub().returns(true);
        serverHealth.addConnectionCheck('one', checkStubOne);
        checkStubTwo = sinon.stub().returns(true);
        serverHealth.addConnectionCheck('two', checkStubTwo);

        server.start(done)
      });

      afterEach(function shutdownServer(done) {
        server.stop(done);
      });

      after(function resetServerHealth() {
        serverHealth.resetConnectionCheck();
      });

      it('calls all connection checks', () => {
        return getHealth()
        .then(() => {
          assert.isTrue(checkStubOne.called);
          assert.isTrue(checkStubTwo.called);
        });
      });

      it('returns a 200 if all connection checks succeed', () => {
        return getHealth()
        .then((response) => {
          assert.equal(response.statusCode, 200);
        });
      });

      it('returns a status=ok if all connection checks succeed', () => {
        return getHealth()
        .then((response) => {
          assert.equal(response.body.status, 'ok');
        });
      });

      describe('Property filtering', () => {

        it('returns all core properties when not filtered', () => {
          return getHealth()
          .then((response) => {
            const status = response.body;

            assert.property(status, 'status');
            assert.property(status, 'uptime');
            assert.property(status, 'upSince');

            assert.nestedProperty(status, 'service.name');
            assert.nestedProperty(status, 'service.description');
            assert.nestedProperty(status, 'service.version');

            assert.property(status, 'connections');
            assert.isObject(status.connections, 'object');

            assert.nestedProperty(status, 'env.nodeEnv');
            assert.nestedProperty(status, 'env.nodeVersion');
            assert.nestedProperty(status, 'env.processName');
            assert.nestedProperty(status, 'env.pid');
            assert.nestedProperty(status, 'env.cwd');

            assert.nestedProperty(status, 'git.commitHash');
            assert.nestedProperty(status, 'git.branchName');
            assert.nestedProperty(status, 'git.tag');
          });
        });

        it('returns only one selected property when filtering by one value', () => {
          return getHealth('filter=status')
          .then((response) => {
            const status = response.body;

            assert.lengthOf(Object.keys(status), 1);
            assert.property(status, 'status');
          });
        });

        it('returns all selected properties when filtering by multiple values', () => {
          return getHealth('filter=status,env.nodeEnv')
          .then((response) => {
            const status = response.body;

            assert.lengthOf(Object.keys(status), 2);
            assert.property(status, 'status');
            assert.nestedProperty(status, 'env.nodeEnv');
          });
        });

        it('returns a 400 error when filtering by an unknown property', () => {
          return getHealth('filter=foo')
          .then((response) => {
            assert.equal(response.statusCode, 400);
            assert.equal(response.body.message, 'Invalid filter path "foo"')
          });
        });

      });

      describe('unhealthy server', () => {

        before(function addUnhealthyCheck() {
          serverHealth.addConnectionCheck(
            'failingConnectionTest',
            sinon.stub().returns(false)
          );
        });

        it('returns a 500 if any connection check fails', () => {
          return getHealth()
          .then((response) => {
            assert.equal(response.statusCode, 500);
          });
        });

        it('returns a status=fail listing the failing connections', () => {
          return getHealth()
          .then((response) => {
            assert.equal(response.body.status, 'fail:failingConnectionTest');
          });
        });

      });

      describe('invalid health check response', () => {

        before(function addUnhealthyCheck() {
          serverHealth.addConnectionCheck(
            'invalidHealthCheck',
            sinon.stub().returns('invalid response')
          );
        });

        it('returns a 500 if any connection check returns a non-boolean', () => {
          return getHealth()
          .then((response) => {
            assert.equal(response.statusCode, 500);
          });
        });

        it('reports the invalid connection check', () => {
          return getHealth()
          .then((response) => {
            assert.include(response.body.message, 'invalidHealthCheck');
          });
        });

      });
    });
  }

});
