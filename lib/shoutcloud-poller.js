'use strict';

var Promise = require('bluebird');

var Deque = require('double-ended-queue'),
	cheerio = require('cheerio'),
	bhttp = require('bhttp');

var Readable = require('stream').Readable,
	util = require('util');

function ShoutcloudPoller(hdConfig, scConfig) {
	Readable.call(this, { objectMode: true });
	
	this.hdConfig = Object.assign({ }, hdConfig);
	this.scConfig = Object.assign({ }, scConfig);
	
	this.shoutUrl = hdConfig.url + scConfig.path;
	this.lastId = 0;
	
	this._messages = new Deque();
	
	this._initialized = false;
	this._reading = false;
	
	this._init();
}
util.inherits(ShoutcloudPoller, Readable);

// initialize
ShoutcloudPoller.prototype._init = function () {
	// update the last shoutbox message id so we don't repeat ourselves
	this._initPromise = this._poll(true).then(() => {
		this._initialized = true;
		
		// if data was requested while we were doing this, kick things off
		if (this._reading) { this._readLoop(); }
	}).catch(err => {
		// we should never get here, but if we do we want to know about it
		console.error('(Shoutcloud: read)', err.stack);
	});
};

// update last id
ShoutcloudPoller.prototype._updateLastId = function (shoutId) {
	let id = parseInt(shoutId.replace(/^shoutid-/, ''), 10);
	if (!isNaN(id)) { this.lastId = Math.max(this.lastId, id); }
	else { console.error('(Shoutcloud: read) Erroneous shoutId:', shoutId); }
}

// returns a promise for a cheerio object of shoutbox messages
// in { nick: 'foo', message: 'bar' } format
ShoutcloudPoller.prototype._poll = function (ignore) {
	let postData = {
		sc_com: 'ajax',
		last: 'shoutid-'+this.lastId
	};
	
	return bhttp.post(this.shoutUrl, postData, { decodeJSON: true })
	.then(data => cheerio.load(data.body.msgs))
	.then($ => 
		$('.shout-msg').map((idx, el) => {
			let $el = $(el);
			
			this._updateLastId($el.attr('id'));
			
			let nickname = $(el).find('strong').text();
			
			// since the text isn't wrapped in anything we can select, instead we'll delete
			// the elements we don't care about
			
			$el.children().remove();
			
			let message = $el.text().trim();
			
			return { nickname, message };
		})
		.get()
		.filter(msg => !/^\(.*\)/.test(msg.nickname))
	)
	.catch(err => {
		console.error('(Shoutcloud: read) Poll error:', err.message);
		return [ ]; // force another poll by returning an empty result set
	})
	.then(data => {
		// we want to ignore the first poll since it gets historical data
		if (ignore) { return; }
		
		if (data.length) {
			data.forEach(msg => {
				console.log('(shoutbox) %s: %s', msg.nickname, msg.message);
				this._messages.push(msg);
			});
			return data;
		}
		
		// we got nothing last time, try until we get something
		return Promise.delay(this.scConfig.pollRate)
			.then(() => this._poll());
	});
};

// Readable stream _read handler
ShoutcloudPoller.prototype._read = function () {
	this._initPromise.then(() => {
		if (!this._messages.length) {
			return this._poll();
		}
	}).then(() => {
		this.push(this._messages.shift());
	}).catch(err => {
		// we should never get here, but if we do we want to know about it
		console.error('(Shoutcloud: read)', err.stack);
	});
};

module.exports = ShoutcloudPoller;