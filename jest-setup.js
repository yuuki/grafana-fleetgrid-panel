// Jest setup provided by Grafana scaffolding
import './.config/jest-setup';

// Canvas 2D context mock for component tests.
// Must be imported here (setupFilesAfterEnv) AFTER './.config/jest-setup', because that
// scaffold file overwrites HTMLCanvasElement.prototype.getContext with a stub that returns
// undefined. Loading jest-canvas-mock last lets its working mock win. Placing it in
// jest.config.js `setupFiles` does not work: it runs first and then gets clobbered.
import 'jest-canvas-mock';
