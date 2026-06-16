const NOTION_VERSION = "2026-03-11";
const NOTICE_PAGE_ID =
  process.env.NOTION_NOTICE_PAGE_ID ||
  "3819e848-42a8-80b0-929f-e306d4d974fc";

function plainText(richText = []) {
  return richText
    .map((part) => part?.plain_text || part?.text?.content || "")
    .join("")
    .trim();
}

function normalizeRichText(richText = []) {
  return richText.map((part) => ({
    text:
      part?.plain_text ||
      part?.text?.content ||
      part?.equation?.expression ||
      "",
    href: part?.href || part?.text?.link?.url || null,
    annotations: {
      bold: Boolean(part?.annotations?.bold),
      italic: Boolean(part?.annotations?.italic),
      strikethrough: Boolean(part?.annotations?.strikethrough),
      underline: Boolean(part?.annotations?.underline),
      code: Boolean(part?.annotations?.code),
      color: part?.annotations?.color || "default",
    },
  }));
}

function iconValue(icon) {
  if (!icon) return "✦";
  if (icon.type === "emoji") return icon.emoji || "✦";
  if (icon.type === "external") return "✦";
  if (icon.type === "file") return "✦";
  return "✦";
}

function pageTitle(page) {
  const properties = page?.properties || {};

  for (const property of Object.values(properties)) {
    if (property?.type === "title") {
      const title = plainText(property.title);
      if (title) return title;
    }
  }

  return "近期委託公告";
}

async function notionRequest(token, url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      payload?.message || `Notion API 回傳 ${response.status}`
    );
  }

  return payload;
}

async function retrieveChildren(token, blockId) {
  const results = [];
  let cursor;

  do {
    const url = new URL(
      `https://api.notion.com/v1/blocks/${blockId}/children`
    );
    url.searchParams.set("page_size", "100");
    if (cursor) url.searchParams.set("start_cursor", cursor);

    const payload = await notionRequest(token, url);
    results.push(...(payload.results || []));
    cursor = payload.has_more ? payload.next_cursor : undefined;
  } while (cursor);

  return results;
}

function blockRichText(block) {
  const data = block?.[block.type] || {};
  return normalizeRichText(data.rich_text || []);
}

function imageData(block) {
  const data = block?.image;
  if (!data) return { url: null, caption: [] };

  const url =
    data.type === "external"
      ? data.external?.url
      : data.type === "file"
        ? data.file?.url
        : null;

  return {
    url,
    caption: normalizeRichText(data.caption || []),
  };
}

async function normalizeBlock(token, block) {
  if (!block || block.in_trash || block.archived) return null;

  const type = block.type;
  let children = [];

  if (block.has_children) {
    const childBlocks = await retrieveChildren(token, block.id);
    children = (
      await Promise.all(
        childBlocks.map((child) => normalizeBlock(token, child))
      )
    ).filter(Boolean);
  }

  if (
    [
      "paragraph",
      "heading_1",
      "heading_2",
      "heading_3",
      "bulleted_list_item",
      "numbered_list_item",
      "quote",
      "toggle",
    ].includes(type)
  ) {
    return {
      type,
      richText: blockRichText(block),
      children,
    };
  }

  if (type === "to_do") {
    return {
      type,
      richText: blockRichText(block),
      checked: Boolean(block.to_do?.checked),
      children,
    };
  }

  if (type === "callout") {
    return {
      type,
      richText: blockRichText(block),
      icon: iconValue(block.callout?.icon),
      children,
    };
  }

  if (type === "divider") {
    return { type, children: [] };
  }

  if (type === "code") {
    return {
      type,
      richText: blockRichText(block),
      language: block.code?.language || "plain text",
      children: [],
    };
  }

  if (type === "image") {
    const image = imageData(block);
    return {
      type,
      url: image.url,
      caption: image.caption,
      children: [],
    };
  }

  if (type === "bookmark") {
    return {
      type,
      url: block.bookmark?.url || null,
      children: [],
    };
  }

  if (children.length) {
    return {
      type: "container",
      children,
    };
  }

  return null;
}

export default async () => {
  const token = process.env.NOTION_TOKEN;

  if (!token) {
    return Response.json(
      {
        message: "尚未設定 NOTION_TOKEN",
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }

  try {
    const [page, rawBlocks] = await Promise.all([
      notionRequest(
        token,
        `https://api.notion.com/v1/pages/${NOTICE_PAGE_ID}`
      ),
      retrieveChildren(token, NOTICE_PAGE_ID),
    ]);

    const blocks = (
      await Promise.all(
        rawBlocks.map((block) => normalizeBlock(token, block))
      )
    ).filter(Boolean);

    return Response.json(
      {
        title: pageTitle(page),
        icon: iconValue(page.icon),
        lastEditedTime: page.last_edited_time || new Date().toISOString(),
        blocks,
      },
      {
        headers: {
          "Cache-Control":
            "public, max-age=0, s-maxage=15, stale-while-revalidate=60",
          "Content-Type": "application/json; charset=utf-8",
        },
      }
    );
  } catch (error) {
    console.error("Notion notice sync failed:", error);

    return Response.json(
      {
        message: "Notion 公告同步失敗",
        detail: error instanceof Error ? error.message : String(error),
      },
      {
        status: 502,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
};

export const config = {
  path: "/api/notice",
};
