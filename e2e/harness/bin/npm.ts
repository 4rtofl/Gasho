#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// The fake npm (fakes.ts): it answers only from the table the test wrote.
import { runFake } from "./run.ts";

await runFake("npm");
