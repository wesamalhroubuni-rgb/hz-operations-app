import { registerRootComponent } from 'expo';

import App from './App';
// Phase 5: the sync engine at the offline runtime's seam, and the background sync task.
import './src/offline/engineRegistration';

// Registers the root component for both Expo Go and native builds.
registerRootComponent(App);
