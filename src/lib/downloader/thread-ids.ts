/** XenForo / forum URL helpers: /forums/name.12/  /threads/title.345/  /posts/678  #post-678 */

export interface ThreadIds {
  forumId: string | null;
  threadId: string | null;
  postId: string | null;
}

export function parseThreadIds(url: string): ThreadIds {
  try {
    const u = new URL(url);
    const path = u.pathname;
    const forum = path.match(/\/forums\/(?:[^/]*?\.)?(\d+)/i);
    const thread = path.match(/\/threads\/(?:[^/]*?\.)?(\d+)/i);
    const postPath = path.match(/\/posts\/(\d+)/i);
    const postHash = u.hash.match(/post-(\d+)/i);
    const postInThread = path.match(/\/threads\/[^/]+\/(?:page-\d+\/)?post-(\d+)/i);
    return {
      forumId: forum?.[1] ?? u.searchParams.get("forum_id") ?? u.searchParams.get("f"),
      threadId: thread?.[1] ?? u.searchParams.get("thread_id") ?? u.searchParams.get("t"),
      postId:
        postPath?.[1] ??
        postInThread?.[1] ??
        postHash?.[1] ??
        u.searchParams.get("post_id") ??
        u.searchParams.get("p"),
    };
  } catch {
    return { forumId: null, threadId: null, postId: null };
  }
}

export function postIdFromAttrs(attrs: string): string | null {
  const id = attrs.match(/\b(?:id|data-content|data-post-id|data-lb-id)=["'](?:js-)?post-?(\d+)/i);
  if (id?.[1]) return id[1];
  const data = attrs.match(/\bdata-post=["'](\d+)/i);
  return data?.[1] ?? null;
}

export function forumIdFromHtml(html: string): string | null {
  const crumb = html.match(/\/forums\/(?:[^"'/]*?\.)?(\d+)/i);
  return crumb?.[1] ?? null;
}
