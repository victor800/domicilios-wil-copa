echo $GOOGLE_CREDENTIALS | node -e "process.stdin.resume();process.stdin.on('data',d=>require('fs').writeFileSync('credentials.json',d))"
node index.js
