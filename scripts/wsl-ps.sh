#!/usr/bin/env bash
echo "=== active build processes ==="
ps -eo pid,etimes,comm,args --sort=-etimes \
  | grep -E "cargo|rustc|anchor|npm|node" \
  | grep -v grep | head -10 || true
echo
echo "=== scaffold project ==="
ls -la "$HOME/x1-gen/demo-app/target/deploy/" 2>/dev/null || echo "(none)"
