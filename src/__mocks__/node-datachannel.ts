// Stub for node-datachannel native addon.
// The addon requires a compiled binary (node_datachannel.node) that is not
// available in this environment. Our tests use TCP transport only; WebRTC
// code paths are never exercised, so an empty stub is sufficient.
export default {};
export class PeerConnection {}
export class IceUdpMuxListener {}
export class DataChannel {}
