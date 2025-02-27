docker run --rm -v $(pwd):/src -u $(id -u):$(id -g) emscripten/emsdk:4.0.3-arm64 emcc ./packages/core/src/wasm/items_manager.c \
  -o ./packages/core/src/wasm/items_manager.js \
  -sMODULARIZE \
  -s EXPORTED_FUNCTIONS='["_get_item_indices_in_window"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap"]' \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME="itemsManager"