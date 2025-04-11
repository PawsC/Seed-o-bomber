const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    pingInterval: 1000,
    pingTimeout: 2000
});
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const lobbies = {};
const games = {};
const rows = 11;
const cols = 21;
const lobbyTimeout = 300000;

function generateLobbyId() {
    return Math.random().toString(36).substring(2, 8);
}

function generateBlocks() {
    const blocks = [];
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            if (Math.random() < 0.7 && 
                !(x <= 1 && y <= 1) && !(x >= 19 && y <= 1) &&
                !(x <= 1 && y >= 9) && !(x >= 19 && y >= 9)) {
                blocks.push({ x, y });
            }
        }
    }
    return blocks;
}

function generateDurableBlocks() {
    const durableBlocks = [];
    const numBlocks = Math.floor(Math.random() * 20) + 5;
    const centerX = 10, centerY = 5;
    const possiblePositions = [];
    for (let y = centerY - 2; y <= centerY + 2; y++) {
        for (let x = centerX - 5; x <= centerX + 5; x++) {
            if (x >= 0 && x < cols && y >= 0 && y < rows && 
                !(x <= 1 && y <= 1) && !(x >= 19 && y <= 1) &&
                !(x <= 1 && y >= 9) && !(x >= 19 && y >= 9)) {
                possiblePositions.push({ x, y });
            }
        }
    }
    for (let i = 0; i < numBlocks && possiblePositions.length > 0; i++) {
        const index = Math.floor(Math.random() * possiblePositions.length);
        durableBlocks.push({ x: possiblePositions[index].x, y: possiblePositions[index].y, hp: 3 });
        possiblePositions.splice(index, 1);
    }
    return durableBlocks;
}

function generateBigBombs(blocks, durableBlocks) {
    const bigBombs = [];
    const numBombs = Math.floor(Math.random() * 3) + 3;
    const centerX = 10, centerY = 5;
    const possiblePositions = [];
    for (let y = centerY - 2; y <= centerY + 2; y++) {
        for (let x = centerX - 2; x <= centerX + 2; x++) {
            if (x >= 0 && x < cols && y >= 0 && y < rows) {
                const isBlocked = blocks.some(b => b.x === x && b.y === y) ||
                                  durableBlocks.some(b => b.x === x && b.y === y);
                if (!isBlocked) {
                    possiblePositions.push({ x, y });
                }
            }
        }
    }
    for (let i = 0; i < numBombs && possiblePositions.length > 0; i++) {
        const index = Math.floor(Math.random() * possiblePositions.length);
        bigBombs.push({ x: possiblePositions[index].x, y: possiblePositions[index].y, active: false });
        possiblePositions.splice(index, 1);
    }
    return bigBombs;
}

function isWalkable(x, y, gameState) {
    return x >= 0 && x < cols && y >= 0 && y < rows &&
        !gameState.blocks.some(b => b.x === x && b.y === y) &&
        !gameState.durableBlocks.some(b => b.x === x && b.y === y) &&
        !gameState.bigBombs.some(b => !b.active && b.x === x && b.y === y) &&
        !gameState.shrunkCells.some(s => s.x === x && s.y === y);
}

function getExplosionArea(x, y) {
    const explosionArea = [{ x, y }];
    const directions = [{ dx: -1, dy: 0 }, { dx: 1, dy: 0 }, { dx: 0, dy: -1 }, { dx: 0, dy: 1 }];
    directions.forEach(dir => {
        const newX = x + dir.dx;
        const newY = y + dir.dy;
        if (newX >= 0 && newX < cols && newY >= 0 && newY < rows) {
            explosionArea.push({ x: newX, y: newY });
        }
    });
    return explosionArea;
}

function getBigExplosionArea(x, y) {
    const explosionArea = [{ x, y }];
    const directions = [
        { dx: -1, dy: 0 }, { dx: -2, dy: 0 },
        { dx: 1, dy: 0 }, { dx: 2, dy: 0 },
        { dx: 0, dy: -1 }, { dx: 0, dy: -2 },
        { dx: 0, dy: 1 }, { dx: 0, dy: 2 }
    ];
    directions.forEach(dir => {
        const newX = x + dir.dx;
        const newY = y + dir.dy;
        if (newX >= 0 && newX < cols && newY >= 0 && newY < rows) {
            explosionArea.push({ x: newX, y: newY });
        }
    });
    return explosionArea;
}

function checkGameOver(lobbyId) {
    const gameState = games[lobbyId];
    if (!gameState) return;

    const alivePlayers = Object.values(gameState.players).filter(p => p.alive);
    if (alivePlayers.length <= 1) {
        const winner = alivePlayers[0];
        if (winner && !winner.scoreUpdated) {
            winner.score = (winner.score || 0) + 1;
            winner.scoreUpdated = true;
        }
        io.to(lobbyId).emit('gameOver', {
            message: winner ? `${winner.name} wins!` : 'No winners!',
            winnerId: winner ? winner.id : null
        });
        delete games[lobbyId];
        io.to(lobbyId).emit('resetShrinkTimer');
    }
}

function checkBorderKill(lobbyId) {
    const gameState = games[lobbyId];
    if (!gameState) return;
    let killed = false;
    Object.values(gameState.players).forEach(player => {
        if (player.alive && gameState.shrunkCells.some(s => s.x === player.x && s.y === player.y)) {
            player.alive = false;
            killed = true;
        }
    });
    if (killed) {
        io.to(lobbyId).emit('gameState', gameState);
        checkGameOver(lobbyId);
    }
}

io.on('connection', (socket) => {
    socket.on('createLobby', ({ name, emoji }) => {
        const lobbyId = generateLobbyId();
        lobbies[lobbyId] = {
            creator: socket.id,
            players: [{ id: socket.id, name, emoji, ready: false, score: 0 }],
            link: lobbyId,
            lastActivity: Date.now()
        };
        socket.join(lobbyId);
        socket.emit('lobbyUpdate', lobbies[lobbyId]);
    });

    socket.on('joinLobby', ({ lobbyId, name }) => {
        const lobby = lobbies[lobbyId];
        if (!lobby) {
            socket.emit('lobbyUpdate', { error: 'Lobby not found!' });
            return;
        }
        if (lobby.players.length >= 4) {
            socket.emit('lobbyUpdate', { error: 'Lobby is full!' });
            return;
        }
        if (games[lobbyId]) {
            socket.emit('lobbyUpdate', { error: 'Game already started in this lobby!' });
            return;
        }
        lobby.players.push({ id: socket.id, name, emoji: null, ready: false, score: 0 });
        lobby.lastActivity = Date.now();
        socket.join(lobbyId);
        io.to(lobbyId).emit('lobbyUpdate', lobby);
        io.to(lobbyId).emit('playerJoined', name);
    });

    socket.on('updateName', (name) => {
        for (const lobbyId in lobbies) {
            const lobby = lobbies[lobbyId];
            const player = lobby.players.find(p => p.id === socket.id);
            if (player) {
                player.name = name;
                lobby.lastActivity = Date.now();
                io.to(lobbyId).emit('lobbyUpdate', lobby);
                break;
            }
        }
    });

    socket.on('selectEmoji', (emoji) => {
        for (const lobbyId in lobbies) {
            const lobby = lobbies[lobbyId];
            const player = lobby.players.find(p => p.id === socket.id);
            if (player) {
                player.emoji = emoji;
                lobby.lastActivity = Date.now();
                io.to(lobbyId).emit('lobbyUpdate', lobby);
                break;
            }
        }
    });

    socket.on('toggleReady', () => {
        for (const lobbyId in lobbies) {
            const lobby = lobbies[lobbyId];
            const player = lobby.players.find(p => p.id === socket.id);
            if (player) {
                player.ready = !player.ready;
                lobby.lastActivity = Date.now();
                io.to(lobbyId).emit('lobbyUpdate', lobby);
                break;
            }
        }
    });

    socket.on('startGame', (lobbyId) => {
        const lobby = lobbies[lobbyId];
        if (!lobby || lobby.players[0].id !== socket.id) return;
        if (lobby.players.length < 2 || !lobby.players.every(p => p.ready || p.id === socket.id)) return;

        const spawnPoints = [
            { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 10 }, { x: 20, y: 10 }
        ];

        const blocks = generateBlocks();
        const durableBlocks = generateDurableBlocks();
        const bigBombs = generateBigBombs(blocks, durableBlocks);

        games[lobbyId] = {
            players: {},
            bombs: [],
            blocks: blocks.filter(block => !spawnPoints.some(sp => sp.x === block.x && sp.y === block.y)),
            durableBlocks: durableBlocks.filter(block => !spawnPoints.some(sp => sp.x === block.x && sp.y === block.y)),
            bigBombs: bigBombs.filter(bomb => !spawnPoints.some(sp => sp.x === bomb.x && sp.y === bomb.y)),
            exploded: [],
            shrunkCells: [],
            aiInterval: null
        };

        lobby.players.forEach((player, index) => {
            games[lobbyId].players[player.id] = {
                id: player.id,
                x: spawnPoints[index].x,
                y: spawnPoints[index].y,
                emoji: player.emoji,
                alive: true,
                name: player.name,
                score: player.score || 0,
                lastBombTime: 0,
                lastMoveTime: 0,
                target: null,
                scoreUpdated: false
            };
        });

        startAI(lobbyId);

        io.to(lobbyId).emit('gameStarted');
        io.to(lobbyId).emit('gameState', games[lobbyId]);
    });

    socket.on('move', ({ x, y }) => {
        for (const lobbyId in games) {
            const gameState = games[lobbyId];
            const player = gameState.players[socket.id];
            if (player && player.alive && isWalkable(x, y, gameState)) {
                player.x = x;
                player.y = y;
                player.lastMoveTime = Date.now();
                io.to(lobbyId).emit('gameState', gameState);
                checkBorderKill(lobbyId);
            }
        }
    });

    socket.on('dropBomb', ({ x, y }) => {
        for (const lobbyId in games) {
            const gameState = games[lobbyId];
            const player = gameState.players[socket.id];
            if (player && player.alive) {
                const now = Date.now();
                if (now - (player.lastBombTime || 0) < 1000) return;
                if (gameState.bombs.some(b => b.x === x && b.y === y)) return;
                const bomb = { x, y, owner: socket.id, placedAt: now };
                gameState.bombs.push(bomb);
                player.lastBombTime = now;
                io.to(lobbyId).emit('gameState', gameState);
                setTimeout(() => {
                    if (games[lobbyId] && games[lobbyId].bombs.includes(bomb)) {
                        explodeBomb(lobbyId, bomb);
                    }
                }, 1000);
            }
        }
    });

    socket.on('shrinkBoard', (newShrunkCells) => {
        for (const lobbyId in games) {
            const gameState = games[lobbyId];
            newShrunkCells.forEach(cell => {
                if (!gameState.shrunkCells.some(s => s.x === cell.x && s.y === cell.y)) {
                    gameState.shrunkCells.push(cell);
                }
            });
            io.to(lobbyId).emit('gameState', gameState);
            checkBorderKill(lobbyId);
            checkGameOver(lobbyId);
        }
    });

    socket.on('gameOver', ({ message, winnerId }) => {
        for (const lobbyId in lobbies) {
            const lobby = lobbies[lobbyId];
            if (lobby.players.some(p => p.id === socket.id)) {
                const winner = lobby.players.find(p => p.id === winnerId);
                if (winner && !winner.scoreUpdated) {
                    winner.score = (winner.score || 0) + 1;
                    winner.scoreUpdated = true;
                }
                lobby.players.forEach(p => {
                    p.ready = false;
                    p.scoreUpdated = false;
                });
                io.to(lobbyId).emit('gameOver', { message });
                io.to(lobbyId).emit('lobbyUpdate', lobby);
                stopAI(lobbyId);
                delete games[lobbyId];
                io.to(lobbyId).emit('resetShrinkTimer');
                break;
            }
        }
    });

    socket.on('requestLobbyUpdate', () => {
        for (const lobbyId in lobbies) {
            const lobby = lobbies[lobbyId];
            if (lobby.players.some(p => p.id === socket.id)) {
                socket.emit('lobbyUpdate', lobby);
                break;
            }
        }
    });

    socket.on('leaveLobby', (lobbyId) => {
        const lobby = lobbies[lobbyId];
        if (!lobby) return;
        lobby.players = lobby.players.filter(p => p.id !== socket.id);
        lobby.lastActivity = Date.now();
        socket.leave(lobbyId);
        if (lobby.players.length === 0) {
            delete lobbies[lobbyId];
            stopAI(lobbyId);
            delete games[lobbyId];
        } else {
            if (lobby.creator === socket.id) {
                lobby.creator = lobby.players[0]?.id;
                const newCreator = lobby.players[0];
                if (newCreator) {
                    newCreator.emoji = 'ðŸŒ±';
                    newCreator.ready = false;
                }
            }
            io.to(lobbyId).emit('lobbyUpdate', lobby);
            if (games[lobbyId]) {
                delete games[lobbyId].players[socket.id];
                io.to(lobbyId).emit('gameState', games[lobbyId]);
                checkGameOver(lobbyId);
            }
        }
    });

    socket.on('disconnect', () => {
        for (const lobbyId in lobbies) {
            const lobby = lobbies[lobbyId];
            const playerIndex = lobby.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                lobby.players.splice(playerIndex, 1);
                lobby.lastActivity = Date.now();
                socket.leave(lobbyId);
                if (lobby.players.length === 0) {
                    delete lobbies[lobbyId];
                    stopAI(lobbyId);
                    delete games[lobbyId];
                } else {
                    if (lobby.creator === socket.id) {
                        lobby.creator = lobby.players[0]?.id;
                        const newCreator = lobby.players[0];
                        if (newCreator) {
                            newCreator.emoji = 'ðŸŒ±';
                            newCreator.ready = false;
                        }
                    }
                    io.to(lobbyId).emit('lobbyUpdate', lobby);
                    if (games[lobbyId]) {
                        delete games[lobbyId].players[socket.id];
                        io.to(lobbyId).emit('gameState', games[lobbyId]);
                        checkGameOver(lobbyId);
                    }
                }
                break;
            }
        }
    });

    function startAI(lobbyId) {
        stopAI(lobbyId);
        const gameState = games[lobbyId];
        if (!gameState) return;

        gameState.aiInterval = setInterval(() => {
            const now = Date.now();
            Object.entries(gameState.players).forEach(([id, player]) => {
                if (player.alive && now - (player.lastMoveTime || 0) >= 500) {
                    player.lastMoveTime = now;

                    let inDanger = false;
                    let dangerAreas = [];
                    gameState.bombs.forEach(bomb => {
                        const explosionArea = getExplosionArea(bomb.x, bomb.y);
                        if (explosionArea.some(e => e.x === player.x && e.y === player.y)) {
                            inDanger = true;
                            dangerAreas = dangerAreas.concat(explosionArea);
                        }
                    });

                    let nearestTarget = null;
                    let minDistance = Infinity;
                    let targetType = null;

                    if (!inDanger) {
                        gameState.bigBombs.forEach(bomb => {
                            if (!bomb.active) {
                                const distance = Math.abs(bomb.x - player.x) + Math.abs(bomb.y - player.y);
                                if (distance < minDistance) {
                                    minDistance = distance;
                                    nearestTarget = bomb;
                                    targetType = 'bigBomb';
                                }
                            }
                        });
                    }

                    if (!nearestTarget || inDanger) {
                        Object.entries(gameState.players).forEach(([otherId, otherPlayer]) => {
                            if (otherId !== id && otherPlayer.alive) {
                                const distance = Math.abs(otherPlayer.x - player.x) + Math.abs(otherPlayer.y - player.y);
                                if (distance < minDistance) {
                                    minDistance = distance;
                                    nearestTarget = otherPlayer;
                                    targetType = 'player';
                                }
                            }
                        });
                    }

                    player.target = nearestTarget;

                    const directions = [
                        { dx: -1, dy: 0 },
                        { dx: 1, dy: 0 },
                        { dx: 0, dy: -1 },
                        { dx: 0, dy: 1 }
                    ];

                    if (inDanger) {
                        const safeMoves = directions
                            .map(d => ({ dx: d.dx, dy: d.dy, x: player.x + d.dx, y: player.y + d.dy }))
                            .filter(move => 
                                isWalkable(move.x, move.y, gameState) &&
                                !dangerAreas.some(e => e.x === move.x && e.y === move.y)
                            );
                        if (safeMoves.length > 0) {
                            const move = safeMoves[Math.floor(Math.random() * safeMoves.length)];
                            player.x = move.x;
                            player.y = move.y;
                        }
                    } else if (nearestTarget) {
                        const dx = nearestTarget.x - player.x;
                        const dy = nearestTarget.y - player.y;
                        let moveDirection = null;
                        if (Math.abs(dx) > Math.abs(dy)) {
                            moveDirection = dx > 0 ? { dx: 1, dy: 0 } : { dx: -1, dy: 0 };
                        } else {
                            moveDirection = dy > 0 ? { dx: 0, dy: 1 } : { dx: 0, dy: -1 };
                        }

                        const newX = player.x + moveDirection.dx;
                        const newY = player.y + moveDirection.dy;
                        if (isWalkable(newX, newY, gameState)) {
                            player.x = newX;
                            player.y = newY;
                        }

                        const distanceToTarget = Math.abs(nearestTarget.x - player.x) + Math.abs(nearestTarget.y - player.y);
                        const canDropBomb = now - (player.lastBombTime || 0) >= 1000;
                        const shouldDropBomb = (targetType === 'player' && distanceToTarget <= 3) ||
                                              (targetType === 'bigBomb' && distanceToTarget <= 1);

                        if (canDropBomb && shouldDropBomb && !gameState.bombs.some(b => b.x === player.x && b.y === player.y)) {
                            const bomb = { x: player.x, y: player.y, owner: id, placedAt: now };
                            gameState.bombs.push(bomb);
                            player.lastBombTime = now;
                            setTimeout(() => {
                                if (games[lobbyId] && games[lobbyId].bombs.includes(bomb)) {
                                    explodeBomb(lobbyId, bomb);
                                }
                            }, 1000);
                        }
                    } else {
                        const possibleMoves = directions
                            .map(d => ({ dx: d.dx, dy: d.dy, x: player.x + d.dx, y: player.y + d.dy }))
                            .filter(move => isWalkable(move.x, move.y, gameState));
                        if (possibleMoves.length > 0) {
                            const move = possibleMoves[Math.floor(Math.random() * possibleMoves.length)];
                            player.x = move.x;
                            player.y = move.y;

                            const canDropBomb = now - (player.lastBombTime || 0) >= 1000;
                            if (canDropBomb && Math.random() < 0.3 && !gameState.bombs.some(b => b.x === player.x && b.y === player.y)) {
                                const bomb = { x: player.x, y: player.y, owner: id, placedAt: now };
                                gameState.bombs.push(bomb);
                                player.lastBombTime = now;
                                setTimeout(() => {
                                    if (games[lobbyId] && games[lobbyId].bombs.includes(bomb)) {
                                        explodeBomb(lobbyId, bomb);
                                    }
                                }, 1000);
                            }
                        }
                    }
                }
            });
            io.to(lobbyId).emit('gameState', gameState);
            checkBorderKill(lobbyId);
            checkGameOver(lobbyId);
        }, 500);
    }

    function stopAI(lobbyId) {
        const gameState = games[lobbyId];
        if (gameState && gameState.aiInterval) {
            clearInterval(gameState.aiInterval);
            gameState.aiInterval = null;
        }
    }

    function explodeBomb(lobbyId, bomb) {
        const gameState = games[lobbyId];
        if (!gameState) return;
        const index = gameState.bombs.indexOf(bomb);
        if (index === -1) return;
        gameState.bombs.splice(index, 1);
        const explosionArea = getExplosionArea(bomb.x, bomb.y);
        gameState.exploded = explosionArea;

        gameState.blocks = gameState.blocks.filter(b => !explosionArea.some(e => e.x === b.x && e.y === b.y));
        gameState.durableBlocks.forEach(block => {
            if (explosionArea.some(e => e.x === block.x && e.y === block.y)) block.hp--;
        });
        gameState.durableBlocks = gameState.durableBlocks.filter(b => b.hp > 0);

        const bigBombsToExplode = gameState.bigBombs.filter(b => !b.active && explosionArea.some(e => e.x === b.x && e.y === b.y));
        bigBombsToExplode.forEach(bomb => {
            bomb.active = true;
            setTimeout(() => {
                if (games[lobbyId]) {
                    explodeBigBomb(lobbyId, bomb);
                }
            }, 500);
        });

        Object.values(gameState.players).forEach(player => {
            if (player.alive && explosionArea.some(e => e.x === player.x && e.y === player.y)) {
                player.alive = false;
            }
        });

        setTimeout(() => {
            if (games[lobbyId]) {
                gameState.exploded = [];
                io.to(lobbyId).emit('gameState', gameState);
                checkBorderKill(lobbyId);
                checkGameOver(lobbyId);
            }
        }, 500);
    }

    function explodeBigBomb(lobbyId, bomb) {
        const gameState = games[lobbyId];
        if (!gameState || !bomb.active) return;
        const explosionArea = getBigExplosionArea(bomb.x, bomb.y);
        gameState.exploded = explosionArea;

        gameState.blocks = gameState.blocks.filter(b => !explosionArea.some(e => e.x === b.x && e.y === b.y));
        gameState.durableBlocks.forEach(block => {
            if (explosionArea.some(e => e.x === block.x && e.y === block.y)) block.hp--;
        });
        gameState.durableBlocks = gameState.durableBlocks.filter(b => b.hp > 0);

        const otherBigBombs = gameState.bigBombs.filter(b => !b.active && b !== bomb && explosionArea.some(e => e.x === b.x && e.y === b.y));
        otherBigBombs.forEach(otherBomb => {
            otherBomb.active = true;
            setTimeout(() => {
                if (games[lobbyId]) {
                    explodeBigBomb(lobbyId, otherBomb);
                }
            }, 500);
        });

        gameState.bigBombs = gameState.bigBombs.filter(b => b !== bomb);

        Object.values(gameState.players).forEach(player => {
            if (player.alive && explosionArea.some(e => e.x === player.x && e.y === player.y)) {
                player.alive = false;
            }
        });

        setTimeout(() => {
            if (games[lobbyId]) {
                gameState.exploded = [];
                io.to(lobbyId).emit('gameState', gameState);
                checkBorderKill(lobbyId);
                checkGameOver(lobbyId);
            }
        }, 500);
    }
});

setInterval(() => {
    const now = Date.now();
    for (const lobbyId in lobbies) {
        const lobby = lobbies[lobbyId];
        if (now - lobby.lastActivity > lobbyTimeout) {
            io.to(lobbyId).emit('lobbyUpdate', { error: 'Lobby timed out due to inactivity.' });
            lobby.players.forEach(player => {
                const socket = io.sockets.sockets.get(player.id);
                if (socket) socket.leave(lobbyId);
            });
            stopAI(lobbyId);
            delete lobbies[lobbyId];
            delete games[lobbyId];
        }
    }
}, 60000);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
