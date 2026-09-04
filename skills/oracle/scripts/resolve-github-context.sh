#!/usr/bin/env bash
set -euo pipefail

repository_path=${1:-.}

if ! git -C "$repository_path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Target is not a Git worktree." >&2
  exit 2
fi

github_slug_from_url() {
  local remote_url=$1
  local slug

  case "$remote_url" in
    git@github.com:*)
      slug=${remote_url#git@github.com:}
      ;;
    ssh://git@github.com/*)
      slug=${remote_url#ssh://git@github.com/}
      ;;
    https://github.com/*)
      slug=${remote_url#https://github.com/}
      ;;
    https://*@github.com/*)
      slug=${remote_url#*@github.com/}
      ;;
    *)
      return 1
      ;;
  esac

  slug=${slug%/}
  slug=${slug%.git}
  if [[ ! "$slug" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    return 1
  fi
  printf '%s' "$slug"
}

slug_for_remote() {
  local remote_name=$1
  local remote_url

  remote_url=$(git -C "$repository_path" remote get-url "$remote_name" 2>/dev/null) || return 1
  github_slug_from_url "$remote_url"
}

branch=$(git -C "$repository_path" branch --show-current)
if [[ -z "$branch" ]]; then
  branch=DETACHED
fi
commit=$(git -C "$repository_path" rev-parse HEAD)

selected_remote=
repository=
if repository=$(slug_for_remote origin); then
  selected_remote=origin
else
  configured_remote=
  if [[ "$branch" != DETACHED ]]; then
    configured_remote=$(git -C "$repository_path" config --get "branch.${branch}.remote" || true)
  fi
  if [[ -n "$configured_remote" && "$configured_remote" != "." ]] &&
    repository=$(slug_for_remote "$configured_remote"); then
    selected_remote=$configured_remote
  else
    candidate_count=0
    while IFS= read -r remote_name; do
      if candidate_slug=$(slug_for_remote "$remote_name"); then
        candidate_count=$((candidate_count + 1))
        selected_remote=$remote_name
        repository=$candidate_slug
      fi
    done < <(git -C "$repository_path" remote)
    if [[ $candidate_count -ne 1 ]]; then
      echo "Could not determine one GitHub repository from Git metadata." >&2
      exit 2
    fi
  fi
fi

dirty=false
if [[ -n "$(git -C "$repository_path" status --porcelain=v1 --untracked-files=normal)" ]]; then
  dirty=true
fi

printf 'repository=%s\n' "$repository"
printf 'branch=%s\n' "$branch"
printf 'commit=%s\n' "$commit"
printf 'dirty=%s\n' "$dirty"
printf 'selected_remote=%s\n' "$selected_remote"

while IFS= read -r remote_name; do
  if remote_slug=$(slug_for_remote "$remote_name"); then
    printf 'github_remote.%s=%s\n' "$remote_name" "$remote_slug"
  fi
done < <(git -C "$repository_path" remote)
