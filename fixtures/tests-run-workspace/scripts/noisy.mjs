const chunk = "x".repeat(1024);
for (let i = 0; i < 200; i++) process.stdout.write(chunk);
process.exit(0);
