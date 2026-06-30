#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: resolve-server-release.sh --event-name <name> --default-branch <branch> --apply-bump <true|false> --publish-github-release <true|false> [--requested-version <X.Y.Z>] [--release-tag <agent-server/vX.Y.Z>] [--agent-root <path>] [--bump-script <path>] [--remote <name>]
EOF
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
agent_root="$(cd "$script_dir/../.." && pwd -P)"
bump_script="$agent_root/../browseros/build/scripts/bump_server_version.py"
remote="origin"

event_name=""
default_branch=""
requested_version=""
release_tag=""
apply_bump=false
publish_github_release=true

while [ "$#" -gt 0 ]; do
  case "$1" in
    --event-name)
      event_name="${2:-}"
      shift 2
      ;;
    --default-branch)
      default_branch="${2:-}"
      shift 2
      ;;
    --requested-version)
      requested_version="${2:-}"
      shift 2
      ;;
    --release-tag)
      release_tag="${2:-}"
      shift 2
      ;;
    --apply-bump)
      apply_bump="${2:-}"
      shift 2
      ;;
    --publish-github-release)
      publish_github_release="${2:-}"
      shift 2
      ;;
    --agent-root)
      agent_root="$(cd "${2:-}" && pwd -P)"
      shift 2
      ;;
    --bump-script)
      bump_script="$(cd "$(dirname "${2:-}")" && pwd -P)/$(basename "${2:-}")"
      shift 2
      ;;
    --remote)
      remote="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [ -z "$event_name" ] || [ -z "$default_branch" ]; then
  usage
  exit 2
fi

case "$apply_bump" in
  true|false) ;;
  *)
    echo "--apply-bump must be true or false" >&2
    exit 2
    ;;
esac

case "$publish_github_release" in
  true|false) ;;
  *)
    echo "--publish-github-release must be true or false" >&2
    exit 2
    ;;
esac

is_semver() {
  [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
}

version_cmp() {
  local left_major left_minor left_patch right_major right_minor right_patch
  IFS=. read -r left_major left_minor left_patch <<< "$1"
  IFS=. read -r right_major right_minor right_patch <<< "$2"

  for part in "$left_major" "$left_minor" "$left_patch" "$right_major" "$right_minor" "$right_patch"; do
    [[ "$part" =~ ^[0-9]+$ ]] || return 2
  done

  if [ "$left_major" -ne "$right_major" ]; then
    [ "$left_major" -gt "$right_major" ] && printf '1\n' || printf -- '-1\n'
    return 0
  fi
  if [ "$left_minor" -ne "$right_minor" ]; then
    [ "$left_minor" -gt "$right_minor" ] && printf '1\n' || printf -- '-1\n'
    return 0
  fi
  if [ "$left_patch" -ne "$right_patch" ]; then
    [ "$left_patch" -gt "$right_patch" ] && printf '1\n' || printf -- '-1\n'
    return 0
  fi
  printf '0\n'
}

version_gt() {
  [ "$(version_cmp "$1" "$2")" = "1" ]
}

version_lt() {
  [ "$(version_cmp "$1" "$2")" = "-1" ]
}

next_patch() {
  local major minor patch
  IFS=. read -r major minor patch <<< "$1"
  printf '%s.%s.%s\n' "$major" "$minor" "$((patch + 1))"
}

tag_version() {
  case "$1" in
    agent-server/v*)
      local candidate="${1#agent-server/v}"
      is_semver "$candidate" && printf '%s\n' "$candidate"
      ;;
    browseros-server-v*)
      local candidate="${1#browseros-server-v}"
      is_semver "$candidate" && printf '%s\n' "$candidate"
      ;;
  esac
}

read_package_version() {
  python3 - "$agent_root/apps/server/package.json" <<'PY'
import json
import sys
from pathlib import Path

print(json.loads(Path(sys.argv[1]).read_text())["version"])
PY
}

read_package_version_at_ref() {
  local ref="$1"
  git -C "$agent_root" show "$ref:apps/server/package.json" | python3 -c '
import json
import sys

try:
    print(json.load(sys.stdin)["version"])
except Exception as exc:
    print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
    sys.exit(1)
'
}

emit() {
  printf '%s=%s\n' "$1" "$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
  fi
}

ensure_git_identity() {
  if ! git -C "$agent_root" config user.name >/dev/null; then
    git -C "$agent_root" config user.name "github-actions[bot]"
  fi
  if ! git -C "$agent_root" config user.email >/dev/null; then
    git -C "$agent_root" config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  fi
}

fetch_default_branch() {
  git -C "$agent_root" fetch "$remote" "$default_branch:refs/remotes/$remote/$default_branch" --no-tags
}

checkout_default_branch() {
  fetch_default_branch
  git -C "$agent_root" switch -C "$default_branch" "$remote/$default_branch"
}

find_previous_tag() {
  local target="$1"
  local target_tag="$2"
  local latest_version=""
  local latest_tag=""

  while IFS= read -r existing_tag; do
    [ -n "$existing_tag" ] || continue

    local existing_version
    existing_version="$(tag_version "$existing_tag" || true)"
    [ -n "$existing_version" ] || continue

    if [ "$existing_version" = "$target" ] && [ "$existing_tag" != "$target_tag" ]; then
      echo "Release version $target already exists as tag $existing_tag" >&2
      return 1
    fi

    if [ "$existing_tag" = "$target_tag" ]; then
      continue
    fi

    if [ -z "$latest_version" ] || version_gt "$existing_version" "$latest_version"; then
      latest_version="$existing_version"
      latest_tag="$existing_tag"
    fi
  done < <(
    {
      git -C "$agent_root" tag -l 'agent-server/v*'
      git -C "$agent_root" tag -l 'browseros-server-v*'
    } | sort -u
  )

  if [ -n "$latest_version" ] && ! version_gt "$target" "$latest_version"; then
    echo "Release version $target must be greater than latest existing server version $latest_version ($latest_tag)" >&2
    return 1
  fi

  printf '%s\n' "$latest_tag"
}

resolve_target_version() {
  local current="$1"

  if [ "$event_name" = "push" ]; then
    if [ -z "$release_tag" ]; then
      echo "Tag releases require --release-tag" >&2
      return 1
    fi
    local parsed
    parsed="$(tag_version "$release_tag" || true)"
    if [ -z "$parsed" ] || [[ "$release_tag" != agent-server/v* ]]; then
      echo "Expected server release tag like agent-server/vX.Y.Z, got: $release_tag" >&2
      return 1
    fi
    printf '%s\n' "$parsed"
    return 0
  fi

  if [ -n "$requested_version" ]; then
    if ! is_semver "$requested_version"; then
      echo "Requested version must be MAJOR.MINOR.PATCH, got: $requested_version" >&2
      return 1
    fi
    if version_gt "$requested_version" "$current"; then
      printf '%s\n' "$requested_version"
      return 0
    fi
    if [ "$apply_bump" = "true" ] && [ "$requested_version" = "$current" ]; then
      next_patch "$current"
      return 0
    fi
    printf '%s\n' "$requested_version"
    return 0
  fi

  if [ "$apply_bump" = "true" ]; then
    next_patch "$current"
    return 0
  fi

  printf '%s\n' "$current"
}

apply_version() {
  local target="$1"
  python3 "$bump_script" --agent-root "$agent_root" --set "$target" >/dev/null
}

current_version="$(read_package_version)"
target_version="$(resolve_target_version "$current_version")"

if version_lt "$target_version" "$current_version"; then
  echo "Requested server version $target_version is lower than apps/server/package.json ($current_version)" >&2
  exit 1
fi

release_tag="agent-server/v$target_version"
previous_tag=""

if [ "$publish_github_release" = "true" ]; then
  checkout_default_branch
  current_version="$(read_package_version)"

  if version_lt "$target_version" "$current_version"; then
    echo "Requested server version $target_version is lower than apps/server/package.json ($current_version)" >&2
    exit 1
  fi

  previous_tag="$(find_previous_tag "$target_version" "$release_tag")"
  ensure_git_identity

  branch_changed=false
  tag_changed=false
  release_sha=""
  existing_tag_sha="$(git -C "$agent_root" rev-list -n 1 "$release_tag" 2>/dev/null || true)"
  existing_tag_type="$(git -C "$agent_root" cat-file -t "refs/tags/$release_tag" 2>/dev/null || true)"

  if [ -n "$existing_tag_sha" ]; then
    existing_tag_version="$(read_package_version_at_ref "$release_tag" || true)"
    if [ -z "$existing_tag_version" ]; then
      echo "Could not read apps/server/package.json version from $release_tag" >&2
      exit 1
    fi

    if [ "$existing_tag_version" = "$target_version" ]; then
      if ! git -C "$agent_root" merge-base \
        --is-ancestor "$existing_tag_sha" "$remote/$default_branch"; then
        echo "Existing $release_tag ($existing_tag_sha) is not reachable from $remote/$default_branch" >&2
        exit 1
      fi

      release_sha="$existing_tag_sha"
      if [ "$existing_tag_type" != "tag" ]; then
        git -C "$agent_root" tag -f -a "$release_tag" "$release_sha" \
          -m "agent-server v$target_version"
        tag_changed=true
      fi
    fi
  fi

  if [ -z "$release_sha" ]; then
    if [ "$target_version" != "$current_version" ]; then
      apply_version "$target_version"
      git -C "$agent_root" add apps/server/package.json bun.lock
      if git -C "$agent_root" diff --cached --quiet; then
        echo "No server version changes produced for $target_version" >&2
        exit 1
      fi
      git -C "$agent_root" commit -m "chore: bump server version to $target_version"
      branch_changed=true
    fi

    release_sha="$(git -C "$agent_root" rev-parse HEAD)"
    if [ "$existing_tag_sha" != "$release_sha" ] || [ "$existing_tag_type" != "tag" ]; then
      git -C "$agent_root" tag -f -a "$release_tag" -m "agent-server v$target_version"
      tag_changed=true
    fi
  fi

  if [ "$branch_changed" = "true" ]; then
    git -C "$agent_root" push --atomic "$remote" \
      "HEAD:refs/heads/$default_branch" \
      "+refs/tags/$release_tag:refs/tags/$release_tag"
    fetch_default_branch
  elif [ "$tag_changed" = "true" ]; then
    git -C "$agent_root" push "$remote" "+refs/tags/$release_tag:refs/tags/$release_tag"
  fi
else
  if [ "$target_version" != "$current_version" ]; then
    apply_version "$target_version"
  fi
  release_sha="$(git -C "$agent_root" rev-parse HEAD)"
  previous_tag="$(find_previous_tag "$target_version" "$release_tag")"
fi

emit package_version "$target_version"
emit tag "$release_tag"
emit release_sha "$release_sha"
emit previous_tag "$previous_tag"
