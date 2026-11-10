export default [{
  files: ['core/**/*.js'],
  languageOptions: { ecmaVersion: 2022, sourceType: 'module',
    globals: { TextDecoder:'readonly', TextEncoder:'readonly', Response:'readonly', Blob:'readonly', DecompressionStream:'readonly', CompressionStream:'readonly', fetch:'readonly', console:'readonly', setTimeout:'readonly', BigInt:'readonly', Uint8Array:'readonly', DataView:'readonly', ArrayBuffer:'readonly', Set:'readonly', Map:'readonly', Math:'readonly', Object:'readonly', Array:'readonly', JSON:'readonly', Promise:'readonly', Error:'readonly', RegExp:'readonly', String:'readonly', Number:'readonly', parseInt:'readonly', Uint16Array:'readonly', crypto:'readonly', structuredClone:'readonly', indexedDB:'readonly', IDBKeyRange:'readonly', globalThis:'readonly', btoa:'readonly', atob:'readonly', DecompressionStream:'readonly', Date:'readonly' } },
  rules: { 'no-undef': 'error' }
}];
