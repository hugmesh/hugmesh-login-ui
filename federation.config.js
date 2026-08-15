// REMOTE config for the hugmesh-login-ui native-federation bundle. This repo
// is a remote (the host hugmesh.net consumes it via loadRemoteModule),
// exposing the login/registration routes under the remote name "login".
//
// The shared-deps surface (singletons, strictVersion, requiredVersion: 'auto')
// + the RxJS skip list live in ./federation-base.js so the federation contract
// lands in ONE file shared with the host and every sibling remote — a drift
// (e.g. one bundle sharing a different RxJS subpath) can't quietly produce a
// "shared is not a function" runtime failure. Mirrors hugmesh.games/frontend.
const { hugmeshRemote } = require('./federation-base');

module.exports = hugmeshRemote({
  name: 'login',
  exposes: {
    './routes': './src/app/login.routes.ts',
  },
  // three.js + Vanta are SKIPPED from the shared surface on purpose.
  //
  // hugmeshRemote() calls shareAll(), which turns every package.json dependency into
  // a shared singleton pre-bundled into its own importmap entry. That is right for
  // the framework and wrong for these two: they exist only behind the login
  // background's dynamic import()s, and sharing them would hoist 154 KB (gzipped)
  // out of a lazily-fetched chunk and into a bundle listed in remoteEntry.json — paid for on
  // a page whose whole job is to show a sign-in form quickly. Skipping keeps esbuild's
  // code splitting in charge, so the animation code is fetched only when an effect is
  // actually about to run. `vanta` additionally cannot be shared as authored: its
  // package main is unbuilt ESM with glslify shader imports, which is why the effects
  // are imported from its prebuilt dist/ bundles.
  extraSkip: ['three', 'vanta'],
});
