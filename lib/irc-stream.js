'use strict';

var Duplex = require('stream').Duplex,
	util = require('util');

var Promise = require('bluebird'),
	Deque = require('double-ended-queue'),
	factory = require('irc-factory'),
	api = new factory.Api();

// Api binds process.uncaughtException and forces an exit with code 0... fuck that!
process.removeAllListeners('uncaughtException');
	
function IrcStream(config) {
	Duplex.call(this, {
		readableObjectMode: true,
		writableObjectMode: true
	});
	
	this.config = Object.assign({ }, config);
	
	// For some reason, the server sends an error(?) saying "you are already logged in"
	// this seems harmless, and I can't seem to discern what the deal is, though I suspect
	// a bug in irc-factory
	let clientConfig = {
		nick: this.config.nick,
		user: this.config.nick,
		password: this.config.pass,
		server: this.config.server,
		port: 6697,
		capab: true,
		sasl: true,
		secure: true,
		realname: 'HD Shoutbox link',
		retryCount: Infinity
	};
	
	this._readWanted = false;
	this._writing = false;

	this._shoutboxMessages = new Deque();
	this._ircMessages = new Deque();
	
	this.nick = config.nick;
	this._connected = false;

	let descriptor = api.createClient(this.config.server, clientConfig);

	this.client = descriptor.irc;
	
	this._init();
}
util.inherits(IrcStream, Duplex);

IrcStream.prototype.log = function (/*...*/) {
	let str = util.format.apply(util, arguments);
	console.log('(IRC) %s', str);
};

IrcStream.prototype._init = function () {
	const isMe        = m => (m.nickname === this.nick);
	const isRelayChan = m => (m.target === this.config.relayChan);
	const isQ         = m => (m.nickname === 'Q' && m.nickname === 'CServe.configKey.org');
	const isDiscord   = m => (m.nickname === this.config.discordBot);

	const on = (event, handler) => api.hookEvent(this.config.server, event, handler);
	
	// temporary debugging
	/*on('*', m => {
		if (!m.raw) { console.log('??', m); }
		else { this.log('<<', m.raw); }
	});*/
	
	// have to keep track of ourself
	on('nick', m => {
		if (!isMe(m)) { return; }
		this.log('Nick changed: %s -> %s', m.nickname, m.newnick);
		this.nick = m.newnick;
	});
	
	// login and autojoin
	on('registered', m => {
		this.log('Connected, authorizing...');
		
		// connected = true enables writing
		this._connected = true;
		// log in to Q
		this.client.raw(["AUTH", this.config.nick, this.config.pass]);
		// join relay chan
		this.client.join(this.config.relayChan);
		// if we have anything in the write-to-irc queue, dump it now
		this._writeBuffer();
	});
	
	// notice wrapper
	// TODO: does Q ever go away and come back? do we get a notification? we need to react and log in again
	on('notice', m => {
		if (m.target !== this.nick || !isQ(m)) { return; }
		
		if (/^You are now logged in/.test(m.message)) {
			this.log('Logged in to Q');
		}
	});

	on('privmsg', m => {
		if (!isRelayChan(m)) { return; }
		if (isDiscord(m)) {
			let matches = m.message.match(/^<([^>]+)> (.*)$/);
			if (!matches) {
				this.log('Error parsing Discord relay message: %s', m.message);
				return;
			}
			m.nickname = matches[1].replace(/[\x00-\x1F]/g, '');
			m.message = matches[2];
			m.source = 'discord';
		} else {
			m.source = 'irc';
		}
		
		this.log('[%s] %s: %s', m.source, m.nickname, m.message);
		this._ircMessages.push(m);
		if (this._readWanted) {
			this._pushIrcMessage();
		}
	});

	// informative only
	on('failed', m => {
		this.log('Reconnect failed');
	});

	// we got dropped
	on('closed', m => {
		this._connected = false;
		this._writing = false;
		this.log('Disconnected');
	});
};

IrcStream.prototype._read = function () {
	if (this._ircMessages.length) {
		this._pushIrcMessage();
	} else {
		this._readWanted = true;
	}
};

IrcStream.prototype._pushIrcMessage = function () {
	this._readWanted = false;
	this.push(this._ircMessages.shift());	
};

IrcStream.prototype._write = function (msg, encoding, callback) {
	// just tack it on the queue, queue will be drained as available
	// TODO: this might need a hard limit in case of spam or inability
	// to clear the queue to irc
	this._shoutboxMessages.push(msg);
	
	this._writeBuffer();
	
	callback();
};

IrcStream.prototype._format = msg => util.format('<%s> %s', msg.nickname, msg.message);

// this should ensure we never disconnect on servers that use the
// standard RFC-1459 throttling system, which IIRC freenode does
// so we don't need anything more complex for the moment.
// we're not bursting here, so it can be a little slow but gives
// us breathing room too.
const ircDelay = msg => 2 + Math.floor(msg.length / 120);

IrcStream.prototype._writeBuffer = function () {
	if (!this._connected || this._writing || !this._shoutboxMessages.length) { return; }
	this._writing = true;
	
	return Promise.try(() => {
		// irc factory doesn't guarantee delivery or provide an asynchronous send,
		// so if this fails it will just get lost. no need to use the peek-trick
		// in shoutcloud-writer here
		let msg = this._shoutboxMessages.shift(),
			str = this._format(msg);

		this.client.privmsg(this.config.relayChan, str);
		
		if (this._shoutboxMessages.length) {
			return Promise.delay(ircDelay(str))
				.then(() => this._writeBuffer());
		}

		this._writing = false;
	}).catch(err => {
		// shouldn't really get here
		console.error('(IRC)', err.stack);
	});
};


module.exports = IrcStream;