
// Derived from Herdr TUI's libghostty-vt patch in herdrdev/herdr#4383.
// Operate on the screen directly so a partial VT sequence survives the clear.
pub fn clearScreen(terminal_: Terminal) callconv(lib.calling_conv) bool {
    const t: *ZigTerminal = (terminal_ orelse return false).terminal;
    if (t.screens.active_key == .alternate) return false;
    const screen = t.screens.active;

    var first = screen.cursor.y;
    while (first > 0) {
        const pin = screen.pages.pin(.{ .active = .{ .y = first } }).?;
        if (!pin.rowAndCell().row.wrap_continuation) break;
        first -= 1;
    }
    var last = screen.cursor.y;
    while (last + 1 < t.rows) {
        const pin = screen.pages.pin(.{ .active = .{ .y = last } }).?;
        if (!pin.rowAndCell().row.wrap) break;
        last += 1;
    }

    screen.clearSelection();
    if (last + 1 < t.rows) {
        screen.clearRows(.{ .active = .{ .y = last + 1 } }, null, false);
    }
    screen.eraseHistory(null);
    if (first > 0) screen.eraseActive(first - 1);
    screen.pages.pin(.{ .active = .{} }).?.rowAndCell().row.wrap_continuation = false;
    screen.scroll(.active);
    if (comptime build_options.kitty_graphics) {
        screen.kitty_images.delete(t.io(), screen.alloc, t, .{ .all = true });
    }
    t.flags.dirty.clear = true;
    return true;
}
