// Entry point: what this tab is depends on the address.
//
//   /                  landing page: join a game, host one, or open a sandbox
//   ?sandbox, ?seed=7  offline sandbox (this tab holds the whole game)
//   ?host=CODE         online sandbox host; ?host=new opens a room
//   ?test=CODE         online sandbox tester screen (pick any seat)
//   ?run=CODE          a real game's host screen (the facilitator); ?run=new opens a room
//   ?game=CODE         a player: join the lobby, then play
//
// Add &net=local to play online through this browser's tabs instead of Firebase (see net/config.ts).

const q = new URLSearchParams(location.search);

if (q.has('sandbox') || q.has('seed')) void import('./sandbox/main');
else void import('./play/pages').then((m) => m.route(q));
