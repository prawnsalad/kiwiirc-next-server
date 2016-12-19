'use strict';

/**
 * TODO:
 * * MAX_CHANNELS to limit num channels per connection
 */


const _ = require('lodash');
var parseIrcLine = require('irc-message').parse;
const clientTransportSockjs = require('./clienttransports/sockjs');
const clientTransportTcp = require('./clienttransports/tcp');
var clientMessageHandler = require('./clientMessageHandler');
const Channels = require('./channel');

// The channel to receive control messages on with client transports that support channels
const controlChannel = '0';

// The channel to default to if channels are not supported on the client transport
const defaultChannel = '1';

const sessions = Object.create(null);

clientTransportSockjs.startAcceptingClients(socketHandler);
clientTransportTcp.startAcceptingClients(socketHandler);

function Session() {
	this.id = Date.now().toString(32) + Math.floor(Math.random() * 1e15).toString(32);
	this.channels = Object.create(null);
	this.removeWs = function removeWs(ws) {
		Object.keys(this.channels).forEach(chan_id => {
			this.channels[chan_id].removeWs(ws);
		});
	};
	this.persistent = false;
}





function socketHandler(ws) {
	var ses = null;

	// If ws doesn't support multiple channels then only one may be set.
	// If ws does support multiple channels then this is ignored
	var current_channel_id = null;

	console.log('New socket. Channel support:', ws.has_channel_support ? 'yes' : 'no');

	ws.setSession = function setSession(session) {
		if (ses) {
			ses.removeWs(ws);
			delete session[ses.id];
		}

		ses = session;
		sessions[ses.id] = ses;
		//ws.write('SESSION ' + ses.id);
		console.log('Set session to ' + session.id);
	};

	ws.findAndSetChannelFromAuth = function findAndSetChannelFromAuth(user, network, pass) {
		let session = findSessionFromAuth(user, network, pass);
		if (session) {
			ws.setSession(session);
			if (session.channels[network]) {
				// Move the socket to the new channel if we dont have multiple channel support
				if (!ws.has_channel_support) {
					if (session.channels[current_channel_id]) {
						session.channels[current_channel_id].removeWs(ws);
					}

					current_channel_id = network;
					session.channels[current_channel_id].addWs(ws);
				}
			}
		}

		return session;
	};

	ws.startNewSession = function() {
		let session = new Session();
		ws.setSession(session);
		return session;
	};

	if (!ws.has_channel_support) {
		let session = ws.startNewSession();
		current_channel_id = defaultChannel;
		let channel = createChannelOnSession(session, current_channel_id);
		channel.addWs(ws);
	}

	ws.on('data', message => {
		console.log('[websocket raw data]', message);

		// Client transports without channel support (ie. plain TCP connection)
		// will only be able to use the default channel
		let data = ws.has_channel_support ?
			extractChannel(message) :
			{ channel: current_channel_id, message: message };

		// A channel but no message is the client creating or joining a channel,
		// so acknowledge it.
		if (ws.has_channel_support && data.channel && !data.message) {
			if (!ses) {
				ws.startNewSession();
			}

			if (!ses.channels[data.channel]) {
				let channel = createChannelOnSession(ses, data.channel);
				channel.addWs(ws);
			}
			ws.write(':' + data.channel);
			return;
		}

		let channel = ses ?
			ses.channels[data.channel] :
			null;

		if (data.message.indexOf('CONTROL ') === 0) {
			handleControlMessage(channel, message);
			return;
		}

		// Only messages on a channel may continue past here
		if (!channel) {
			console.log('No channel. ignoring data');
			return;
		}

		let irc_message = parseIrcLine(data.message);

		if (!channel.isUpstreamConnected()) {
			handlePreConnectionMessage(channel, irc_message);
		} else {
			clientMessageHandler.handleLine(ses, ws, channel, irc_message);
		}
	});

	ws.on('close', () => {
		console.log('Socket closed');
		if (ses) {
			ses.removeWs(ws);
		}

		let clients_still_connectioned = false;

		if (ses && !ses.persistent) {
			console.log('Closing channels');
			for (let channelId in ses.channels) {
				let channel = ses.channels[channelId];
				if (channel.upstream && channel.ws.length === 0) {
					console.log('Closing upstream');
					channel.upstream.quit();
				} else {
					clients_still_connectioned = true;
				}
			}

			if (!clients_still_connectioned) {
				console.log('Removing session');
				delete sessions[ses.id];
			}

			ses = null;
		} else {
			console.log('keeping IRC connection alive');
		}
	});


	function handlePreConnectionMessage(channel, message) {
		if (message.command === 'HOST') {
			// Default IRC connection details
			let server_host = '';
			let server_port = '6667';
			let server_tls = false;

			// HOST irc.freenode.net:+6697
			// HOST irc.freenode.net:6667
			// HOST irc.freenode.net

			let server_addr_str = message.params[0];

			// Split server:+port into parts
			let server_addr_parts = server_addr_str.split(':');
			server_host = server_addr_parts[0];
			server_port = server_addr_parts[1] || '6667';
			server_tls = false;

			if (server_port[0] === '+') {
				server_tls = true;
				server_port = server_port.substr(1);
			}

			let buffer = channel.state.network.buffer;
			buffer.host = server_host;
			buffer.port = parseInt(server_port);
			buffer.tls = server_tls;

			// HOST always comes before NICK and USER. Reset those so we don't
			// accidently connect before receiving them again
			buffer.nick = '';
			buffer.username = '';
			buffer.realname = '';

		} else if (message.command === 'PASS') {
			let pass = message.params[0] || '';
			// Matching for user/network:password
			let local_account_match = pass.match(/^([a-z0-9_]+)\/([a-z0-9_]+):(.+)$/);
			local_account_match = false;

			if (!local_account_match) {

				let buffer = channel.state.network.buffer;
				buffer.password = pass;

			} else {
				let user = local_account_match[1];
				let network = local_account_match[2];
				let local_pass = local_account_match[3];

				let authed_session = ws.findAndSetChannelFromAuth(user, network, local_pass);
				if (!authed_session) {
					channel.writeStatus('No account or network with that login could be found', ws);
					console.log('Session or channel not found');
				} else {
					syncChannelToClient(ses.channels[current_channel_id], ws);
				}

				return;
			}

		} else if (message.command === 'USER') {
			// TODO: ignore this message if we're already connected upstream
			// USER notaq notaq localhost :notaq
			channel.state.network.buffer.username = message.params[1];
			channel.state.network.buffer.realname = message.params[3];

		} else if (message.command === 'NICK' && message.params[0]) {
			channel.state.network.buffer.nick = message.params[0];
		}

		channel.connectIfReady();
	}

	function handleControlMessage(channel, message) {
		let parts = message.split(' ');

		// Remove CONTROL from the start
		parts.shift();

		if (parts[0] === 'SESSION') {
			if (sessions[parts[1]]) {
				console.log('CONTINUE SESSION ' + parts[1]);
				setSession(sessions[parts[1]]);
				ws.findAndSetChannelFromAuth();
			} else {
				console.log('UNKNOWN SESSION, CREATING NEW');
				ws.startNewSession();
			}

		} else if (parts[0] === 'START') {
			console.log('NEW SESSION');
			ws.startNewSession();

		} else if (parts[1] === 'LIST' && parts[2] === 'NETWORKS') {
			for (let channelId in ses.channels) {
				let channel = ses.channels[channelId];
				let props = [];
				props.push('NAME=' + channel.state.network.name);
				props.push('CHANNEL=' + channelId);
				props.push('HOST=' + channel.state.network.buffer.host);
				props.push('PORT=' + channel.state.network.buffer.port);
				props.push('TLS=' + (channel.state.network.buffer.tls ? '1' : '0'));
				props.push('NICK=' + channel.state.network.nick);
				if (channel.state.network.buffer.password) {
					props.push('PASS=' + channel.state.network.buffer.password);
				}

				channel.write('CONTROL LISTING NETWORK ' + props.join(' '), ws);

				channel.state.buffers.forEach(buffer => {
					let props = [];
					props.push('CHANNEL=' + channelId);
					props.push('NAME=' + buffer.name);
					props.push('JOINED=' + (buffer.joined ? '1' : '0'));
					channel.write('CONTROL LISTING BUFFER ' + props.join(' '));
				});
			}
		}
	}
}



function findSessionFromAuth(user, network, pass) {
	console.log('Finding session', user, network, pass);
	let session = sessions[user];
	if (!session) {
		console.log('Session doesnt exist');
		return false;
	}
	console.log('found session');
	// TODO: Actually auth with a password here
	return session;
}


function createChannelOnSession(session, channel_id_or_obj) {
	let channel_obj;

	if (typeof channel_id_or_obj === 'string') {
		let channel_id = channel_id_or_obj;
		channel_obj = Channels.create(session.id, channel_id);
	} else {
		channel_obj = channel_id_or_obj;

		// if the channel is currently under another session, switch it to the new one
		let current_session = sessions[channel_obj.session_id];
		if (current_session && current_session.channels[channel_obj.id]) {
			delete current_session.channels[channel_obj.id];
			channel_obj.session_id = session.id;
		}
	}

	session.channels[channel_obj.id] = channel_obj;
	return channel_obj;
}

// Extract the channel ID from a websocket message
function extractChannel(line) {
	if (line[0] !== ':') {
		return {
			channel: '',
			message: line,
		};
	}

	let spacePos = line.indexOf(' ');
	if (spacePos === -1) {
		return {
			channel: line.substr(1),
			message: '',
		};
	}

	return {
		channel: line.substr(1, spacePos - 1),
		message: line.substr(spacePos + 1),
	};
}



function messageToLine(message) {
	let line = '';
	if (message.prefix) {
		line += ':' + message.prefix + ' ';
	}

	line += message.command;

	for(let i=0; i<message.params.length; i++) {
		if (i === message.params.length - 1) {
			line += ' :' + message.params[i];
		} else {
			line += ' ' + message.params[i];
		}
	}

	return line;
}

function syncChannelToClient(channel, ws) {
	console.log('Syncing session..');

	console.log('Registration lines:', channel.state.network.registration_complete.length);
	channel.state.network.registration_complete.forEach(message => {
		message.params[0] = channel.state.network.nick;
		console.log(messageToLine(message));
		channel.write(messageToLine(message), ws);
	});

	console.log('Support lines:', channel.state.network.support.length);
	channel.state.network.support.forEach(message => {
		message.params[0] = channel.state.network.nick;
		console.log(messageToLine(message));
		channel.write(messageToLine(message), ws);
	});

	console.log('MOTD:', channel.state.network.motd.length);
	channel.state.network.motd.forEach(message => {
		message.params[0] = channel.state.network.nick;
		channel.write(messageToLine(message), ws);
	});

	console.log('Channels:', channel.state.buffers.size);
	channel.state.buffers.forEach(buffer => {
		console.log('Syncing', buffer.name);
		channel.upstream.raw('TOPIC ' + buffer.name);
		channel.upstream.raw('NAMES ' + buffer.name);
		channel.write(`:${channel.state.network.mask} JOIN ${buffer.name} * :${channel.upstream.user.gecos}`, ws);
	});
}

