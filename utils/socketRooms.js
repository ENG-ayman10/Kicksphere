const normalizeRoomValue = (value, maxLength = 120) => {
  if (value === undefined || value === null) return null;

  const room = String(value).trim().replace(/\s+/g, ' ');
  if (!room || room.length > maxLength) return null;

  return room;
};

const userRoom = userId => `user:${userId}`;
const matchRoom = matchId => `match:${matchId}`;
const teamRoom = teamName => `team:${teamName}`;

module.exports = {
  matchRoom,
  normalizeRoomValue,
  teamRoom,
  userRoom
};
