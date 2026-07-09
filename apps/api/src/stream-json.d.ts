declare module 'stream-json/filters/pick.js' {
  export function pick(options: { filter: RegExp }): NodeJS.ReadWriteStream;
}

declare module 'stream-json/streamers/stream-values.js' {
  export function streamValues(): NodeJS.ReadWriteStream;
}
