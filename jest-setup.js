// Jest setup provided by Grafana scaffolding
import './.config/jest-setup';

// jest-canvas-mock must load AFTER ./.config/jest-setup, which runs in
// setupFilesAfterEnv and sets `HTMLCanvasElement.prototype.getContext = () => {}`.
// Importing it here (rather than via jest.config `setupFiles`) ensures the mock
// wins the last write, so component tests get a working 2D canvas context.
import 'jest-canvas-mock';
