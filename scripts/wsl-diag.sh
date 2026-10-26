#!/usr/bin/env bash
echo "=== active processes ==="
ps -eo pid,etimes,comm,args --sort=-etimes \
  | grep -E "cargo|anchor|git|npm|yarn|rustc" \
  | grep -v grep | head -10 || true

echo
echo "=== work dir ==="
ls -la "$HOME/x1-deploy-test" 2>/dev/null || echo "(missing)"

echo
echo "=== files created ==="
find "$HOME/x1-deploy-test" -maxdepth 2 -type f 2>/dev/null | head -20 || echo "(none)"

echo
echo "=== cargo registry size ==="
du -sh "$HOME/.cargo/registry" 2>/dev/null || echo "(no registry yet)"

echo
echo "=== anchor binary ==="
ls -lh /usr/local/bin/anchor 2>/dev/null || echo "(missing)"
