#include <emscripten.h>

long long get_item_size(long long item) {
  return item >> 32;
}

long long get_item_offset(long long item) {
  return item & 0xffffffff;
}

EMSCRIPTEN_KEEPALIVE
long long make_item(int size, int offset) {
  return ((long long) size << 32) | (long long) offset;
}

int is_item_in_window(
  long long item,
  long long cursor_offset,
  long long cursor_size,
  long long window_size
) {
  return (
    get_item_offset(item) <= cursor_offset + cursor_size + window_size &&
    get_item_offset(item) + get_item_size(item) >= cursor_offset - window_size
  );
}

EMSCRIPTEN_KEEPALIVE
int get_item_indices_in_window(
  long long* items,
  long long* result,
  int items_count,
  int cursor_offset,
  int cursor_size,
  int window_size
) {
  int result_count = 0;
  for (int i = 0; i < items_count; ++i) {
    if (is_item_in_window(items[i], cursor_offset, cursor_size, window_size)) {
      result[result_count++] = i;
    }
  }
  return result_count;
}

EMSCRIPTEN_KEEPALIVE
int get_top_padding(
  long long* items,
  int first_item_index
) {
  return get_item_offset(items[first_item_index]);
}

EMSCRIPTEN_KEEPALIVE
int get_bottom_padding(
  long long* items,
  int total_items,
  int last_item_index
) {
  long long last_item = items[total_items - 1];
  long long last_item_in_window = items[last_item_index];
  return (
    get_item_offset(last_item) +
    get_item_size(last_item) -
    get_item_offset(last_item_in_window) -
    get_item_size(last_item_in_window)
  );
}
