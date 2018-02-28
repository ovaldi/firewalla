'use strict';

const log = require("../../net2/logger")('httpd');

const express = require('express');
const https = require('https');
const forge = require('node-forge');
const qs = require('querystring');
const path = require('path');
const intel = require('./intel.js');

const port = 80;
const httpsPort = 443;
const enableHttps = false;
const enableRedis = true;

const promise = require('bluebird');
const redis = require('redis');
const client = redis.createClient();
promise.promisifyAll(redis.RedisClient.prototype);

const VIEW_PATH = 'firewalla_view';
const STATIC_PATH = 'firewalla_static';

class App {
  constructor() {
    this.app = express();
    this.app.engine('pug', require('pug').__express);
    this.app.set('views', path.join(__dirname, VIEW_PATH));
    this.app.set('view engine', 'pug');
    this.app.disable('view cache'); //debug only
    this.routes();
  }

  routes() {
    this.router = express.Router();
    this.router.all('/block', async (req, res) => {
      const hostname = req.hostname;
      const url = qs.unescape(req.query.url);
      const ip = req.ip;
      const method = req.method;

      log.info("Got a request in block views");

      res.render('block', {hostname, url, ip, method});
    })

    this.app.use('/' + VIEW_PATH, this.router);
    this.app.use('/' + STATIC_PATH, express.static(path.join(__dirname, STATIC_PATH)));

    this.app.use('*', async (req, res) => {
      log.info("Got a request in *");

      if (!req.originalUrl.includes(VIEW_PATH)) {
        let cat = await intel.check(req.hostname);

        log.info(`${req.hostname} 's category is ${cat}`);

        switch(cat) {
          case 'porn':
            this.isPorn(req, res);
            break;
          case 'ad':
            this.isAd(req, res);
            break;
          default:
            res.status(200).send().end();
        }
      }
    });
  }

  start() {
    this.app.listen(port, () => log.info(`Httpd listening on port ${port}!`));

    if (enableHttps) {
      const httpsOptions = this.genHttpsOptions();
      https.createServer(httpsOptions, this.app).listen(httpsPort, () => log.info(`Httpd listening on port ${httpsPort}!`));
    }
  }

  isPorn(req, res) {
    res.status(303).location(`/${VIEW_PATH}/block?${qs.stringify({url: req.originalUrl})}`).send().end();
    if (enableRedis) {
      client.hincrbyAsync('block:stats', 'porn', 1).then(value => {
        log.info(`Total porn blocked: ${value}`);
      });
    }
  }

  isAd(req, res) {
    res.status(200).send().end();
    if (enableRedis) {
      client.hincrbyAsync('block:stats', 'ad', 1).then(value => {
        log.info(`Total ad blocked: ${value}`);
      });
    }
  }

  genHttpsOptions() {
    // generate a keypair and create an X.509v3 certificate
    const pki = forge.pki;
    console.log('Generating 1024-bit key-pair...');
    const keys = pki.rsa.generateKeyPair(1024);
    console.log('Key-pair created.');

    console.log('Creating self-signed certificate...');
    const cert = pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
    let attrs = [{
      name: 'commonName',
      value: 'blackhole.firewalla.com'
    }, {
      name: 'countryName',
      value: 'US'
    }, {
      shortName: 'ST',
      value: 'New York'
    }, {
      name: 'localityName',
      value: 'Brooklyn'
    }, {
      name: 'organizationName',
      value: 'BLACKHOLE'
    }, {
      shortName: 'OU',
      value: 'BLACKHOLE'
    }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([{
      name: 'basicConstraints',
      cA: true/*,
    pathLenConstraint: 4*/
    }, {
      name: 'keyUsage',
      keyCertSign: true,
      digitalSignature: true,
      nonRepudiation: true,
      keyEncipherment: true,
      dataEncipherment: true
    }, {
      name: 'extKeyUsage',
      serverAuth: true,
      clientAuth: true,
      codeSigning: true,
      emailProtection: true,
      timeStamping: true
    }, {
      name: 'nsCertType',
      client: true,
      server: true,
      email: true,
      objsign: true,
      sslCA: true,
      emailCA: true,
      objCA: true
    }]);
    cert.sign(keys.privateKey);
    log.info('Certificate created.');

    return {
      key: pki.privateKeyToPem(keys.privateKey),
      cert: pki.certificateToPem(cert)
    };
  }
}

new App().start();