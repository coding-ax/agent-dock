#!/usr/bin/env python3
"""校验原生产物的符号基线：它引用的 glibc / libstdc++ 符号版本不得超过老机器上有的上限。

超过就说明编它的工具链不对（比如在新发行版上编），这种产物发出去只会把"加载失败"换个地方复现。
用法：verify-baseline.py <addon.node>
"""
import re
import subprocess
import sys

LIMITS = {'GLIBC': (2, 28), 'GLIBCXX': (3, 4, 25)}


def show(version):
    return '.'.join(str(part) for part in version)


def main(path):
    dump = subprocess.check_output(['readelf', '--version-info', path], text=True, errors='replace')
    ok = True
    for name, limit in sorted(LIMITS.items()):
        versions = {tuple(int(part) for part in match.split('.')) for match in re.findall(name + r'_(\d+(?:\.\d+)+)', dump)}
        actual = max(versions) if versions else (0,)
        print('%s: 产物要求 %s，基线上限 %s' % (name, show(actual), show(limit)))
        if actual > limit:
            ok = False
    print('符号基线检查通过' if ok else '符号基线检查未通过：产物要求高于基线，不要发布这份产物')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
