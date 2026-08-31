#!/bin/bash
cd /home/momo/projects/DSBWW/DeepSeek-Whale-Pet || exit 1
# 结束旧实例（用 electron 二进制名，而非路径）
pkill -f 'electron .' 2>/dev/null
sleep 1
rm -f /tmp/whale_run.log
nohup ./node_modules/.bin/electron . > /tmp/whale_run.log 2>&1 &
echo "relaunched pid=$!"