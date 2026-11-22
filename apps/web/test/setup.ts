import { cleanup } from "@testing-library/react";
import { MotionGlobalConfig } from "framer-motion";
import { afterEach } from "vitest";

// Testing Library unmounts what a test drew by itself only where afterEach is a global (Vitest's globals are off).
afterEach(cleanup);

// The test DOM rejects the animations that are cancelled when a part goes away.
MotionGlobalConfig.skipAnimations = true;
