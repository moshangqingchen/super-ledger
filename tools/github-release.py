"""Publish this project's source releases using the existing Git credential manager.

All external connections are TLS tunnels through the explicitly configured local
HTTP proxy. Credentials stay in process memory and are never logged or written.
Run --help for supported release operations. No automatic direct fallback exists.
"""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
from urllib.parse import quote, urlsplit

OWNER = "moshangqingchen"
REPO = "super-ledger"
PROXY = "http://127.0.0.1:10090"
API_ROOT = "/repos/" + OWNER + "/" + REPO


def credentials():
    environment = dict(os.environ, HTTP_PROXY=PROXY, HTTPS_PROXY=PROXY,
                       ALL_PROXY=PROXY, NO_PROXY="", GCM_INTERACTIVE="never", GIT_TERMINAL_PROMPT="0")
    result = subprocess.run(["git", "-c", "http.proxy=" + PROXY, "credential", "fill"],
                            input="protocol=https\nhost=github.com\n\n", text=True,
                            capture_output=True, env=environment, timeout=45)
    if result.returncode:
        raise RuntimeError("GitHub credential manager could not provide an existing login. No credentials were printed.")
    values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    token = values.get("password")
    if not token:
        raise RuntimeError("GitHub authentication is not available; sign in through Git credential manager first.")
    return token


def request(token, method, endpoint, payload=None, file=None, host="api.github.com"):
    if host not in ("api.github.com", "uploads.github.com"):
        raise ValueError("Unapproved GitHub API host")
    proxy = urlsplit(PROXY)
    connection = http.client.HTTPSConnection(proxy.hostname, proxy.port, timeout=120,
                                             context=ssl.create_default_context())
    connection.set_tunnel(host, 443)
    headers = {"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "SuperLedger-Release-Publisher"}
    body = None
    stream = None
    try:
        if file:
            stream = open(file, "rb")
            body = stream
            headers["Content-Type"] = "application/octet-stream"
            headers["Content-Length"] = str(Path(file).stat().st_size)
        elif payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
            headers["Content-Length"] = str(len(body))
        connection.request(method, endpoint, body=body, headers=headers)
        response = connection.getresponse()
        raw = response.read(8 * 1024 * 1024)
        parsed = json.loads(raw) if raw else {}
        if response.status < 200 or response.status >= 300:
            # The server's general message is safe; never print headers or an
            # entire credential-bearing request when reporting errors.
            raise RuntimeError("GitHub HTTP " + str(response.status) + ": " + str(parsed.get("message", "request failed")))
        return parsed
    finally:
        if stream:
            stream.close()
        connection.close()


def compact_release(value):
    return {key: value.get(key) for key in ("id", "tag_name", "html_url", "draft", "prerelease", "upload_url")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("profile")
    sub.add_parser("create-repo")
    sub.add_parser("repo")
    new = sub.add_parser("create-release")
    new.add_argument("tag"); new.add_argument("--body-file", required=True); new.add_argument("--name")
    get = sub.add_parser("release"); get.add_argument("tag")
    upload = sub.add_parser("upload"); upload.add_argument("release_id", type=int); upload.add_argument("file"); upload.add_argument("--name")
    assets = sub.add_parser("assets"); assets.add_argument("release_id", type=int)
    publish = sub.add_parser("publish"); publish.add_argument("release_id", type=int)
    args = parser.parse_args()
    token = credentials()
    profile = request(token, "GET", "/user")
    if profile.get("login") != OWNER:
        raise RuntimeError("The credential manager account does not match the selected repository owner.")
    if args.action == "profile":
        output = {"login": profile["login"], "id": profile["id"]}
    elif args.action == "create-repo":
        value = request(token, "POST", "/user/repos", {"name": REPO, "description": "超级账本：Windows 与 Android 本地记账、扫码加密同步和可选覆盖更新", "private": False, "auto_init": False, "has_issues": True, "has_wiki": False})
        output = {key: value.get(key) for key in ("full_name", "html_url", "clone_url", "private", "default_branch")}
    elif args.action == "repo":
        value = request(token, "GET", API_ROOT)
        output = {key: value.get(key) for key in ("full_name", "html_url", "clone_url", "private", "default_branch")}
    elif args.action == "create-release":
        value = request(token, "POST", API_ROOT + "/releases", {"tag_name": args.tag, "target_commitish": "main", "name": args.name or ("超级账本 " + args.tag), "body": Path(args.body_file).read_text(encoding="utf-8-sig"), "draft": True, "prerelease": False})
        output = compact_release(value)
    elif args.action == "release":
        output = compact_release(request(token, "GET", API_ROOT + "/releases/tags/" + quote(args.tag, safe="")))
    elif args.action == "upload":
        source = Path(args.file).resolve(strict=True)
        name = args.name or source.name
        if "/" in name or "\\" in name:
            raise ValueError("Asset name must be a filename")
        with open(source, "rb") as input_file:
            expected = hashlib.file_digest(input_file, "sha256").hexdigest()
        value = request(token, "POST", API_ROOT + "/releases/" + str(args.release_id) + "/assets?name=" + quote(name, safe=""), file=source, host="uploads.github.com")
        if value.get("size") != source.stat().st_size or value.get("state") != "uploaded":
            raise RuntimeError("Uploaded release asset size/state mismatch; inspect this asset before retrying.")
        digest = value.get("digest")
        if digest and digest != "sha256:" + expected:
            raise RuntimeError("Uploaded release asset hash mismatch; release remains draft.")
        output = {key: value.get(key) for key in ("id", "name", "size", "digest", "browser_download_url", "state")}
        output["local_sha256"] = expected
    elif args.action == "assets":
        output = [{key: asset.get(key) for key in ("id", "name", "size", "digest", "browser_download_url", "state")} for asset in request(token, "GET", API_ROOT + "/releases/" + str(args.release_id) + "/assets?per_page=100")]
    else:
        output = compact_release(request(token, "PATCH", API_ROOT + "/releases/" + str(args.release_id), {"draft": False, "make_latest": "true"}))
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
