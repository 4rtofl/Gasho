// Never finishes loading (import() never settles): the screen gives up after 15 seconds.
await new Promise(() => {});
export default {};
