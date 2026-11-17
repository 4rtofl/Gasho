import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library unmounts what a test drew by itself only where afterEach is a global (Vitest's globals are off).
afterEach(cleanup);
