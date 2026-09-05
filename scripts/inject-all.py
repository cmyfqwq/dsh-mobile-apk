#!/usr/bin/env python3
"""inject-all.py — 快照注入单 pass 合并器（Phase 2c 结构性提速，2026-09-05）。

合并原三步链（每步各自全量解压+preset9 重压缩，~743MB tar × 3 遍）为**单 pass tar 流处理**：
  ① @dsh-android 命名空间注入（原 inject-snapshot.py：profiles/{web,headless}/node_modules/@dsh-android/<pkg>/）
  ② 根级插件注入（原 inject-external-plugins.py：undo/market 等非 scoped 包，lib/skills/清单文件）
  ③ cordis.patch.yml 权威装配覆盖（原 update-snapshot-patch.py：仅 web profile，--all-profiles 展开）
压缩从 ×4 → ×1、解压从 ×4 → ×1；发布档 preset 由 DSH_INJECT_PRESET 控制（默认 9 保发布保真，
-Fast dev 循环传 1 —— 743MB tar 上 preset9≈380s / preset1≈75s / xz -T0 -6≈48s 实测，2026-09-05）。

用法：
  python inject-all.py <snapshot.tar.xz> <out.tar.xz> <authoritative.patch.yml> --dsh-android <dir>... --external <dir>... [--all-profiles]
字节级 tar 流替换，保留 symlink 元数据（Windows bsdtar 解包 symlink 需特权——tar 流处理不物化）。
"""
import io
import json as _json
import lzma
import os
import sys
import tarfile
import time

PROFILES = ("web", "headless")
DSH_ANDROID_NS = "node_modules/@dsh-android/"
EXT_INCLUDE_FILES = ("package.json", "cordis.patch.yml", "spec.json", "README.md", "README.zh-CN.md", "LICENSE")


def parse_args(argv):
    if len(argv) < 4:
        print(__doc__)
        sys.exit(2)
    src, dst, patch_src = argv[1], argv[2], argv[3]
    dsh_dirs, ext_dirs, all_profiles = [], [], False
    i = 4
    while i < len(argv):
        if argv[i] == "--dsh-android":
            i += 1
            while i < len(argv) and not argv[i].startswith("--"):
                dsh_dirs.append(argv[i]); i += 1
        elif argv[i] == "--external":
            i += 1
            while i < len(argv) and not argv[i].startswith("--"):
                ext_dirs.append(argv[i]); i += 1
        elif argv[i] == "--all-profiles":
            all_profiles = True; i += 1
        else:
            print("未知参数: " + argv[i]); sys.exit(2)
    return src, dst, patch_src, dsh_dirs, ext_dirs, all_profiles


def build_dsh_replacements(pkg_dirs):
    """@dsh-android 包名 -> {lib 相对路径 -> bytes} + package.json bytes"""
    out = {}
    for d in pkg_dirs:
        name = os.path.basename(os.path.normpath(d))
        files = {}
        lib = os.path.join(d, "lib")
        for root, _dirs, fnames in os.walk(lib):
            for fn in fnames:
                if fn.endswith(".map"):
                    continue
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, lib).replace("\\", "/")
                with open(full, "rb") as f:
                    files["lib/" + rel] = f.read()
        with open(os.path.join(d, "package.json"), "rb") as f:
            files["package.json"] = f.read()
        out[name] = files
    return out


def build_ext_replacements(pkg_dirs):
    """根级插件：真实包名（package.json name，可 scoped）-> {rel -> bytes}"""
    out = {}
    for d in pkg_dirs:
        try:
            with open(os.path.join(d, "package.json"), "rb") as f:
                name = _json.load(f)["name"]
        except Exception:
            name = os.path.basename(os.path.normpath(d))
        files = {}
        for sub in ("lib", "skills"):
            base = os.path.join(d, sub)
            if not os.path.isdir(base):
                continue
            for root, _dirs, fnames in os.walk(base):
                for fn in fnames:
                    if fn.endswith(".map"):
                        continue
                    full = os.path.join(root, fn)
                    rel = os.path.relpath(full, d).replace("\\", "/")
                    with open(full, "rb") as f:
                        files[rel] = f.read()
        for fn in EXT_INCLUDE_FILES:
            full = os.path.join(d, fn)
            if os.path.isfile(full):
                with open(full, "rb") as f:
                    files[fn] = f.read()
        if files:
            out[name] = files
    return out


def match_dsh_android(name, dsh_names):
    """命中返回 (pkg, rel)；lib/*(-.map) 与 package.json 可注入。"""
    parts = name.split("/")
    if len(parts) < 8 or parts[0:2] != ["home", ".dsh"]:
        return None
    if parts[2] != "profiles" or parts[3] not in PROFILES:
        return None
    if parts[4:6] != ["node_modules", "@dsh-android"]:
        return None
    pkg = parts[6]
    if pkg not in dsh_names:
        return None
    rel = "/".join(parts[7:])
    if rel.startswith("lib/"):
        return (pkg, rel) if not rel.endswith(".map") else None
    return (pkg, rel) if rel == "package.json" else None


def match_ext(name, ext_names):
    """命中返回 (pkg, rel)：lib/*(-.map) / skills/* / 清单文件。"""
    if not name.startswith("home/.dsh/profiles/"):
        return None
    for pkg in ext_names:
        marker = f"/node_modules/{pkg}/"
        idx = name.find(marker)
        if idx < 0:
            continue
        rel = name[idx + len(marker):]
        if rel.startswith("lib/") and not rel.endswith(".map"):
            return (pkg, rel)
        if rel.startswith("skills/"):
            return (pkg, rel)
        if rel in EXT_INCLUDE_FILES:
            return (pkg, rel)
    return None


def main():
    src, dst, patch_src, dsh_dirs, ext_dirs, all_profiles = parse_args(sys.argv)
    preset = int(os.environ.get("DSH_INJECT_PRESET", "9"))
    with open(patch_src, "rb") as f:
        patch_bytes = f.read()
    dsh_repl = build_dsh_replacements(dsh_dirs)
    ext_repl = build_ext_replacements(ext_dirs)
    dsh_names = set(dsh_repl.keys())
    ext_names = set(ext_repl.keys())
    print(f"inject-all: preset={preset} | @dsh-android: {sorted(dsh_names)} | external: {sorted(ext_names)}")

    with lzma.open(src, "rb") as f:
        raw = f.read()
    outbuf = io.BytesIO()
    replaced = 0
    added_files = 0
    seen_dsh = set()
    seen_ext = set()
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:*") as tin, \
            tarfile.open(fileobj=outbuf, mode="w", format=tarfile.PAX_FORMAT) as tout:

        def push(data, name, mtime, mode):
            newm = tarfile.TarInfo(name)
            newm.size = len(data)
            newm.mtime = mtime
            newm.mode = mode
            tout.addfile(newm, io.BytesIO(data))

        for member in tin:
            name = member.name
            if member.isfile():
                hit = match_dsh_android(name, dsh_names) or match_ext(name, ext_names)
                if hit is not None:
                    pkg, rel = hit
                    pool = dsh_repl if (pkg in dsh_names and DSH_ANDROID_NS in name) else ext_repl
                    data = pool[pkg].get(rel)
                    if data is not None:
                        (seen_dsh if pkg in dsh_names else seen_ext).add(pkg)
                        push(data, name, int(member.mtime), member.mode)
                        replaced += 1
                        continue
                if name.startswith("home/.dsh/profiles/") and name.endswith("/cordis.patch.yml") \
                        and "/node_modules/" not in name:
                    prof = name.split("/")[3]
                    if prof == "web" or all_profiles:
                        push(patch_bytes, name, int(member.mtime), member.mode)
                        replaced += 1
                        print("  patch replaced:", name)
                    else:
                        print("  skip (non-web profile):", name)
                        tout.addfile(member, tin.extractfile(member))
                    continue
                tout.addfile(member, tin.extractfile(member))
            else:
                # symlink/dir/hardlink：无内容，元数据原样复制
                tout.addfile(member)

        # 追加模式：快照内不存在的包 → 全部文件落到 web profile（目录项一并生成）
        now = int(time.time())
        for pkg in sorted(dsh_names - seen_dsh):
            base = f"home/.dsh/profiles/web/node_modules/@dsh-android/{pkg}"
            for dirpath in [base, base + "/lib"]:
                ti = tarfile.TarInfo(dirpath)
                ti.type = tarfile.DIRTYPE
                ti.mode = 0o755
                ti.mtime = now
                tout.addfile(ti)
            for rel, data in sorted(dsh_repl[pkg].items()):
                push(data, base + "/" + rel, now, 0o644)
                added_files += 1
            print(f"  [add] @dsh-android/{pkg} ({len(dsh_repl[pkg])} files)")
        for pkg in sorted(ext_names - seen_ext):
            base = f"home/.dsh/profiles/web/node_modules/{pkg}"
            for rel, data in sorted(ext_repl[pkg].items()):
                mode = 0o755 if rel.endswith(".sh") or (rel.startswith("lib/") and data[:2] == b"#!") else 0o644
                push(data, base + "/" + rel, now, mode)
                added_files += 1
            print(f"  [add] {pkg} ({len(ext_repl[pkg])} files)")

    with lzma.open(dst, "wb", preset=preset) as f:
        f.write(outbuf.getvalue())
    print(f"replaced entries: {replaced} | added files: {added_files} | preset={preset}")
    print("written:", dst, os.path.getsize(dst), "bytes")


if __name__ == "__main__":
    main()
