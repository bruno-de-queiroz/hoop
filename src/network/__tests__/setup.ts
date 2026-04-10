import { vi } from 'vitest';

vi.mock('node-datachannel', () => ({
  default: {},
  PeerConnection: class PeerConnection {},
  IceUdpMuxListener: class IceUdpMuxListener {},
  DataChannel: class DataChannel {},
}));
