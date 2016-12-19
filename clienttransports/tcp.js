'use strict';

var EventEmitter = require('events').EventEmitter;
var net = require('net');

module.exports.startAcceptingClients = function(fn) {
	let server = net.createServer(socket => {
		socket.setEncoding('utf8');

		let client = new EventEmitter();
		client.has_channel_support = false;

		client.write = (line) => {
			socket.write(`${line}\r\n`);
		};

		socket.on('close', () => client.emit('close'));

		let buffer = '';
		socket.on('data', data => {
			buffer += data;

			let lines = buffer.split('\n');
			if (lines[lines.length - 1] !== '') {
				buffer = lines.pop();
			} else {
				lines.pop();
				buffer = '';
			}

			lines.forEach(_line => {
				let line = _line.trim();
				client.emit('data', line);
			});
		});

		fn(client);
	});

	server.listen(6667);
};
