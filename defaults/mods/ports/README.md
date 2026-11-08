# Training monitoring through Herdr Ports

Reuse an existing TensorBoard or other HTTP monitoring service. Inspect its
listening address, port, PID and experiment/log directory first. Do not restart
training or its monitor just to obtain a local URL. For a new monitor requested
by the user, bind it to remote loopback and keep it independent of training.

Herdr automatically discovers listening services in its terminal process trees.
A detached supervisor may no longer belong to a terminal tree. Register that
existing service explicitly on the development machine:

```sh
python3 ~/.config/herdr-custom/port-forwarding/herdr-monitor.py request \
  --port 6006 --pid <actual-listening-pid> \
  --label "TensorBoard: experiment name" --path '/#scalars'
python3 ~/.config/herdr-custom/port-forwarding/herdr-monitor.py links \
  --port 6006 --wait 60
```

The helper is shipped in this repository as `defaults/mods/ports/herdr-monitor.py`; copy it
and this guide to the remote directory above when setting up a machine. It uses
Python's standard library, creates private JSON files and never starts, stops or
sends input to a service. Registration checks that the PID belongs to the user
and owns a listening socket on that port. Discovery checks the process start
time too, so a recycled PID cannot revive an obsolete registration.

Select that machine's workspace in Herdr and leave Ports Auto on. A custom
transport needs its SSH alias configured in Ports. Explicit Stop remains in
effect until Forward is clicked again. Closed/inactive clients do not discover
new registrations. Remote agents cannot override those choices.

Use the `url` returned by `links`, not an assumed localhost port: Herdr chooses
another free local port when the requested port is occupied. The response names
the local computer; use `--client <name-or-id>` if multiple computers connect.
No response means forwarding has not been acknowledged; report the wait/error
and ask the user to select the machine/check Ports instead of inventing a URL.
Responses expire after 60 seconds without a client heartbeat. A returned URL
confirms the mapping, not application health: verify an HTTP endpoint through
it on the local computer before claiming the dashboard works. Ordinary SSH
reconnection preserves the chosen local port when it remains available; it
does not resume a stopped remote service.

Suggested user prompt:

> 请为这次训练配置或复用 TensorBoard 监控，不中断训练。按
> `~/.config/herdr-custom/port-forwarding/README.md` 登记服务，查询 Herdr
> 返回的实际本机链接。回复可点击网址、应该选择的实验曲线和刷新间隔；
> 没拿到回执时不要猜测本地端口。
