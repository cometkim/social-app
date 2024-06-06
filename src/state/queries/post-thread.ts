import {
  AppBskyActorDefs,
  AppBskyEmbedRecord,
  AppBskyFeedDefs,
  AppBskyFeedGetPostThread,
  AppBskyFeedPost,
  AtUri,
  BskyAgent,
  ModerationDecision,
  ModerationOpts,
} from '@atproto/api'
import {QueryClient, useQuery, useQueryClient} from '@tanstack/react-query'

import {moderatePost_wrapped as moderatePost} from '#/lib/moderatePost_wrapped'
import {UsePreferencesQueryResponse} from '#/state/queries/preferences/types'
import {useAgent} from '#/state/session'
import {
  findAllPostsInQueryData as findAllPostsInSearchQueryData,
  findAllProfilesInQueryData as findAllProfilesInSearchQueryData,
} from 'state/queries/search-posts'
import {
  findAllPostsInQueryData as findAllPostsInNotifsQueryData,
  findAllProfilesInQueryData as findAllProfilesInNotifsQueryData,
} from './notifications/feed'
import {
  findAllPostsInQueryData as findAllPostsInFeedQueryData,
  findAllProfilesInQueryData as findAllProfilesInFeedQueryData,
} from './post-feed'
import {
  didOrHandleUriMatches,
  embedViewRecordToPostView,
  getEmbeddedPost,
} from './util'

const RQKEY_ROOT = 'post-thread'
export const RQKEY = (uri: string) => [RQKEY_ROOT, uri]
type ThreadViewNode = AppBskyFeedGetPostThread.OutputSchema['thread']

export interface ThreadCtx {
  depth: number
  isHighlightedPost?: boolean
  hasMore?: boolean
  isParentLoading?: boolean
  isChildLoading?: boolean
}

export type ThreadPost = {
  type: 'post'
  _reactKey: string
  uri: string
  post: AppBskyFeedDefs.PostView
  record: AppBskyFeedPost.Record
  parent?: ThreadNode
  replies?: ThreadNode[]
  ctx: ThreadCtx
}

export type ThreadNotFound = {
  type: 'not-found'
  _reactKey: string
  uri: string
  ctx: ThreadCtx
}

export type ThreadBlocked = {
  type: 'blocked'
  _reactKey: string
  uri: string
  ctx: ThreadCtx
}

export type ThreadUnknown = {
  type: 'unknown'
  uri: string
}

export type ThreadNode =
  | ThreadPost
  | ThreadNotFound
  | ThreadBlocked
  | ThreadUnknown

export type ThreadModerationCache = WeakMap<ThreadNode, ModerationDecision>

export function usePostThreadQuery(uri: string | undefined) {
  const queryClient = useQueryClient()
  const agent = useAgent()
  return useQuery<ThreadNode, Error>({
    gcTime: 0,
    queryKey: RQKEY(uri || ''),
    async queryFn() {
      const res = await getPostThread(agent, uri!)
      if (res.success) {
        return responseToThreadNodes(res.data.thread)
      }
      return {type: 'unknown', uri: uri!}
    },
    enabled: !!uri,
    placeholderData: () => {
      if (!uri) return
      const post = findPostInQueryData(queryClient, uri)
      if (post) {
        return post
      }
      return undefined
    },
  })
}

async function getPostThread(
  agent: BskyAgent,
  uri: string,
): Promise<AppBskyFeedGetPostThread.Response> {
  const res = await agent.getPostThread({uri})

  if (AppBskyFeedDefs.isThreadViewPost(res.data.thread)) {
    // check for a self-thread with posts yet-unloaded
    const selfThreadTerminus = findSelfThreadPrematureEnd(
      res.data.thread.post.author.did,
      res.data.thread,
    )
    if (selfThreadTerminus) {
      // tack on one more page to get more of the thread
      const continuation = await agent.getPostThread({
        uri: selfThreadTerminus.post.uri,
      })
      if (AppBskyFeedDefs.isThreadViewPost(continuation.data.thread)) {
        selfThreadTerminus.replies = continuation.data.thread.replies
      }
    }
  }

  return res
}

export function fillThreadModerationCache(
  cache: ThreadModerationCache,
  node: ThreadNode,
  moderationOpts: ModerationOpts,
) {
  if (node.type === 'post') {
    cache.set(node, moderatePost(node.post, moderationOpts))
    if (node.parent) {
      fillThreadModerationCache(cache, node.parent, moderationOpts)
    }
    if (node.replies) {
      for (const reply of node.replies) {
        fillThreadModerationCache(cache, reply, moderationOpts)
      }
    }
  }
}

export function sortThread(
  node: ThreadNode,
  opts: UsePreferencesQueryResponse['threadViewPrefs'],
  modCache: ThreadModerationCache,
): ThreadNode {
  if (node.type !== 'post') {
    return node
  }
  if (node.replies) {
    node.replies.sort((a: ThreadNode, b: ThreadNode) => {
      if (a.type !== 'post') {
        return 1
      }
      if (b.type !== 'post') {
        return -1
      }

      const aIsByOp = a.post.author.did === node.post?.author.did
      const bIsByOp = b.post.author.did === node.post?.author.did
      if (aIsByOp && bIsByOp) {
        return a.post.indexedAt.localeCompare(b.post.indexedAt) // oldest
      } else if (aIsByOp) {
        return -1 // op's own reply
      } else if (bIsByOp) {
        return 1 // op's own reply
      }

      const aBlur = Boolean(modCache.get(a)?.ui('contentList').blur)
      const bBlur = Boolean(modCache.get(b)?.ui('contentList').blur)
      if (aBlur !== bBlur) {
        if (aBlur) {
          return 1
        }
        if (bBlur) {
          return -1
        }
      }

      if (opts.prioritizeFollowedUsers) {
        const af = a.post.author.viewer?.following
        const bf = b.post.author.viewer?.following
        if (af && !bf) {
          return -1
        } else if (!af && bf) {
          return 1
        }
      }

      if (opts.sort === 'oldest') {
        return a.post.indexedAt.localeCompare(b.post.indexedAt)
      } else if (opts.sort === 'newest') {
        return b.post.indexedAt.localeCompare(a.post.indexedAt)
      } else if (opts.sort === 'most-likes') {
        if (a.post.likeCount === b.post.likeCount) {
          return b.post.indexedAt.localeCompare(a.post.indexedAt) // newest
        } else {
          return (b.post.likeCount || 0) - (a.post.likeCount || 0) // most likes
        }
      } else if (opts.sort === 'random') {
        return 0.5 - Math.random() // this is vaguely criminal but we can get away with it
      }
      return b.post.indexedAt.localeCompare(a.post.indexedAt)
    })
    node.replies.forEach(reply => sortThread(reply, opts, modCache))
  }
  return node
}

// internal methods
// =

function responseToThreadNodes(
  node: ThreadViewNode,
  depth = 0,
  direction: 'up' | 'down' | 'start' = 'start',
): ThreadNode {
  if (
    AppBskyFeedDefs.isThreadViewPost(node) &&
    AppBskyFeedPost.isRecord(node.post.record) &&
    AppBskyFeedPost.validateRecord(node.post.record).success
  ) {
    const post = node.post
    // These should normally be present. They're missing only for
    // posts that were *just* created. Ideally, the backend would
    // know to return zeros. Fill them in manually to compensate.
    post.replyCount ??= 0
    post.likeCount ??= 0
    post.repostCount ??= 0
    return {
      type: 'post',
      _reactKey: node.post.uri,
      uri: node.post.uri,
      post: post,
      record: node.post.record,
      parent:
        node.parent && direction !== 'down'
          ? responseToThreadNodes(node.parent, depth - 1, 'up')
          : undefined,
      replies:
        node.replies?.length && direction !== 'up'
          ? node.replies
              .map(reply => responseToThreadNodes(reply, depth + 1, 'down'))
              // do not show blocked posts in replies
              .filter(node => node.type !== 'blocked')
          : undefined,
      ctx: {
        depth,
        isHighlightedPost: depth === 0,
        hasMore:
          direction === 'down' && !node.replies?.length && !!node.replyCount,
      },
    }
  } else if (AppBskyFeedDefs.isBlockedPost(node)) {
    return {type: 'blocked', _reactKey: node.uri, uri: node.uri, ctx: {depth}}
  } else if (AppBskyFeedDefs.isNotFoundPost(node)) {
    return {type: 'not-found', _reactKey: node.uri, uri: node.uri, ctx: {depth}}
  } else {
    return {type: 'unknown', uri: ''}
  }
}

function findPostInQueryData(
  queryClient: QueryClient,
  uri: string,
): ThreadNode | void {
  let partial
  for (let item of findAllPostsInQueryData(queryClient, uri)) {
    if (item.type === 'post') {
      // Currently, the backend doesn't send full post info in some cases
      // (for example, for quoted posts). We use missing `likeCount`
      // as a way to detect that. In the future, we should fix this on
      // the backend, which will let us always stop on the first result.
      const hasAllInfo = item.post.likeCount != null
      if (hasAllInfo) {
        return item
      } else {
        partial = item
        // Keep searching, we might still find a full post in the cache.
      }
    }
  }
  return partial
}

export function* findAllPostsInQueryData(
  queryClient: QueryClient,
  uri: string,
): Generator<ThreadNode, void> {
  const atUri = new AtUri(uri)

  const queryDatas = queryClient.getQueriesData<ThreadNode>({
    queryKey: [RQKEY_ROOT],
  })
  for (const [_queryKey, queryData] of queryDatas) {
    if (!queryData) {
      continue
    }
    for (const item of traverseThread(queryData)) {
      if (item.type === 'post' && didOrHandleUriMatches(atUri, item.post)) {
        const placeholder = threadNodeToPlaceholderThread(item)
        if (placeholder) {
          yield placeholder
        }
      }
      const quotedPost =
        item.type === 'post' ? getEmbeddedPost(item.post.embed) : undefined
      if (quotedPost && didOrHandleUriMatches(atUri, quotedPost)) {
        yield embedViewRecordToPlaceholderThread(quotedPost)
      }
    }
  }
  for (let post of findAllPostsInFeedQueryData(queryClient, uri)) {
    yield postViewToPlaceholderThread(post)
  }
  for (let post of findAllPostsInNotifsQueryData(queryClient, uri)) {
    yield postViewToPlaceholderThread(post)
  }
  for (let post of findAllPostsInSearchQueryData(queryClient, uri)) {
    yield postViewToPlaceholderThread(post)
  }
}

export function* findAllProfilesInQueryData(
  queryClient: QueryClient,
  did: string,
): Generator<AppBskyActorDefs.ProfileView, void> {
  const queryDatas = queryClient.getQueriesData<ThreadNode>({
    queryKey: [RQKEY_ROOT],
  })
  for (const [_queryKey, queryData] of queryDatas) {
    if (!queryData) {
      continue
    }
    for (const item of traverseThread(queryData)) {
      if (item.type === 'post' && item.post.author.did === did) {
        yield item.post.author
      }
      const quotedPost =
        item.type === 'post' ? getEmbeddedPost(item.post.embed) : undefined
      if (quotedPost?.author.did === did) {
        yield quotedPost?.author
      }
    }
  }
  for (let profile of findAllProfilesInFeedQueryData(queryClient, did)) {
    yield profile
  }
  for (let profile of findAllProfilesInNotifsQueryData(queryClient, did)) {
    yield profile
  }
  for (let profile of findAllProfilesInSearchQueryData(queryClient, did)) {
    yield profile
  }
}

function* traverseThread(node: ThreadNode): Generator<ThreadNode, void> {
  if (node.type === 'post') {
    if (node.parent) {
      yield* traverseThread(node.parent)
    }
    yield node
    if (node.replies?.length) {
      for (const reply of node.replies) {
        yield* traverseThread(reply)
      }
    }
  }
}

function threadNodeToPlaceholderThread(
  node: ThreadNode,
): ThreadNode | undefined {
  if (node.type !== 'post') {
    return undefined
  }
  return {
    type: node.type,
    _reactKey: node._reactKey,
    uri: node.uri,
    post: node.post,
    record: node.record,
    parent: undefined,
    replies: undefined,
    ctx: {
      depth: 0,
      isHighlightedPost: true,
      hasMore: false,
      isParentLoading: !!node.record.reply,
      isChildLoading: !!node.post.replyCount,
    },
  }
}

function postViewToPlaceholderThread(
  post: AppBskyFeedDefs.PostView,
): ThreadNode {
  return {
    type: 'post',
    _reactKey: post.uri,
    uri: post.uri,
    post: post,
    record: post.record as AppBskyFeedPost.Record, // validated in notifs
    parent: undefined,
    replies: undefined,
    ctx: {
      depth: 0,
      isHighlightedPost: true,
      hasMore: false,
      isParentLoading: !!(post.record as AppBskyFeedPost.Record).reply,
      isChildLoading: true, // assume yes (show the spinner) just in case
    },
  }
}

function embedViewRecordToPlaceholderThread(
  record: AppBskyEmbedRecord.ViewRecord,
): ThreadNode {
  return {
    type: 'post',
    _reactKey: record.uri,
    uri: record.uri,
    post: embedViewRecordToPostView(record),
    record: record.value as AppBskyFeedPost.Record, // validated in getEmbeddedPost
    parent: undefined,
    replies: undefined,
    ctx: {
      depth: 0,
      isHighlightedPost: true,
      hasMore: false,
      isParentLoading: !!(record.value as AppBskyFeedPost.Record).reply,
      isChildLoading: true, // not available, so assume yes (to show the spinner)
    },
  }
}

/**
 * Helper to find the last LOADED post of a self-thread, if it exists
 */
function findSelfThreadPrematureEnd(
  authorDid: string,
  node: AppBskyFeedDefs.ThreadViewPost,
): AppBskyFeedDefs.ThreadViewPost | undefined {
  let parent = node.parent
  while (parent && AppBskyFeedDefs.isThreadViewPost(parent)) {
    if (parent.post.author.did !== authorDid) {
      // not a self-thread
      return undefined
    }
    parent = parent.parent
  }

  for (let i = 0; i < 10; i++) {
    if (node.post.replyCount && !node.replies?.length) {
      return node
    }
    const reply = node.replies?.find(
      r =>
        AppBskyFeedDefs.isThreadViewPost(r) && r.post.author.did === authorDid,
    )
    if (!AppBskyFeedDefs.isThreadViewPost(reply)) {
      return undefined
    }
    node = reply
  }
  return undefined
}
