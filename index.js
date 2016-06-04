'use strict';

var config = require('./config.json');

var ShoutcloudPoller = require('./lib/shoutcloud-poller'),
	scp = new ShoutcloudPoller(config.harddrop, config.shoutcloud);

var ShoutcloudWriter = require('./lib/shoutcloud-writer'),
	scw = new ShoutcloudWriter(config.harddrop, config.shoutcloud);

var IrcStream = require('./lib/irc-stream'),
	irc = new IrcStream(config.irc);

irc.pipe(scw);
scp.pipe(irc);