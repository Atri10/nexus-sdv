// Registers happy-dom globals so @testing-library/react works under `bun test`.
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();
