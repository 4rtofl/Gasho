#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// The fake gh (fakes.ts): it answers only from the table the test wrote.
import { runFake } from "./run.ts";

await runFake("gh");
