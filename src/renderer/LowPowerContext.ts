import { createContext } from 'react';

/** Selects the 30fps loop instead of the normal 60fps fluid loop. */
export const LowPowerContext = createContext(false);
