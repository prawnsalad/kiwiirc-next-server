'use strict';

var IrcClient = require('../kiwiirc/node_modules/irc-framework/').Client;



module.exports.handleLine = handleClientLine;

function handleClientLine(session, ws, channel, message) {
	let line = message.raw;

	// Invalid message? Just forward it upstream
	if (!message) {
		return maybeSendDataToIrcServer(channel, line);
	}

	// The IRCd and kiwi server ping amongst themselves
	if (message.command === 'PING') {
		channel.write('PONG ' + message.params[0], ws);
		return;
	}
	if (message.command === 'PONG') {
		return;
	}

	if (message.command === 'NICK' && message.params[0]) {
		channel.state.network.buffer.nick = message.params[0];
	}

	if (message.command === 'PRIVMSG' && message.params[0] === '*status') {
		//channel.write(`:*status!bnc@kiwiirc PRIVMSG ${channel.state.network.nick} :${JSON.stringify(channel.state)}`, ws);
		if (message.params[1] === 'disconnect') {
			channel.upstream.quit();
		} else if (message.params[1] === 'connect') {
			channel.upstream.connect();
		}
		return;
	}

	if (message.command === 'QUIT') {
		// Some clients send QUIT when they close, we want to stay connected.
		// TODO: Provide a way to actually force a quit. How does ZNC manage it?
		return;
	}

	if (message.command === 'USER') {
		// irc-framework handles this for us
		return;
	}

	if (message.command === 'CAP') {
		// irc-framework handles this for us
		return;
	}

	// Not done anything at this point? Forward it upstream
	maybeSendDataToIrcServer(channel, line);
}



function maybeSendDataToIrcServer(channel, line) {
	if (channel.upstream) {
		console.log('raw to server', line);
		channel.upstream.raw(line);
	}
}

