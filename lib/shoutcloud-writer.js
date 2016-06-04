'use strict';

var Promise = require('bluebird');

var Deque = require('double-ended-queue'),
	cheerio = require('cheerio'),
	bhttp = require('bhttp');

var Writable = require('stream').Writable,
	util = require('util');

function ShoutcloudWriter(hdConfig, scConfig) {
	Writable.call(this, { objectMode: true });
	
	this.hdConfig = Object.assign({ }, hdConfig);
	this.scConfig = Object.assign({ }, scConfig);
	
	this.loginUrl = hdConfig.url + hdConfig.loginPath;
	this.shoutUrl = hdConfig.url + scConfig.path;
	
	this.messages = new Deque();
	
	this._writing = false;
}
util.inherits(ShoutcloudWriter, Writable);

// Writable _write handler
ShoutcloudWriter.prototype._write = function (msg, encoding, callback) {
	this.messages.push(msg);

	this._writeLoop();

	setImmediate(callback);
};

// sends a message to the shoutbox, returns a promise
ShoutcloudWriter.prototype._send = function (msg) {
	let postData = {
		sc_com: (msg.source === 'discord' ? 'discordpost' : 'ircpost'),
		irc_h:  this.scConfig.ircKey,
		nick: msg.nickname,
		msg: msg.message
	};
	
	return bhttp.post(this.shoutUrl, postData, { decodeJSON: true })
		.then(res => {
			if (res.statusCode !== 200) { throw new Error(res.statusCode + ' ' + res.statusMessage); }
		});
};

// sends the message queue to the shoutobx until empty
ShoutcloudWriter.prototype._writeLoop = function () {
	if (this.messages.length === 0) { return; }

	let msg = this.messages.peekFront();

	this._send(msg)
		.then(() => {
			// we peeked the message to send, but we won't remove
			// it from the queue until the send is successful
			this.messages.shift();
		})
		.catch(err => {
			console.error('(Shoutcloud: write)', err.stack);
		})
		.then(() => {
			if (!this.messages.length) {
				this._writing = false;
				return;
			}
			// send the next message(s) after a delay
			return Promise.delay(this.scConfig.writeDelay)
				.then(() => this._writeLoop());
		});
};

module.exports = ShoutcloudWriter;