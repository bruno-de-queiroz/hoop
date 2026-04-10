// Stub for node-datachannel/polyfill.
// These polyfills provide WebRTC globals (RTCPeerConnection etc.) via the
// native node-datachannel addon, which is not available in this environment.
// Our tests use TCP transport only, so empty stubs are sufficient.
export class RTCCertificate {}
export class RTCDataChannel {}
export class RTCDtlsTransport {}
export class RTCIceCandidate {}
export class RTCIceTransport {}
export class RTCPeerConnection {}
export class RTCSctpTransport {}
export class RTCSessionDescription {}
export class RTCDataChannelEvent {}
export class RTCPeerConnectionIceEvent {}
export class RTCError {}
export default {
  RTCCertificate,
  RTCDataChannel,
  RTCDtlsTransport,
  RTCIceCandidate,
  RTCIceTransport,
  RTCPeerConnection,
  RTCSctpTransport,
  RTCSessionDescription,
  RTCDataChannelEvent,
  RTCPeerConnectionIceEvent,
  RTCError,
};
