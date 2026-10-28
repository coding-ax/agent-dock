process.stdin.setEncoding('utf8');
process.stdin.on('data', input => process.stdout.write(`AgentDock PTY echo: ${input}`));
