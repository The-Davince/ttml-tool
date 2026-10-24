import { Fragment, createElement, type ReactNode } from "react";
import styles from "./Markdown.module.css";

const isSafeHref = (href: string) => /^https?:\/\//i.test(href);

const renderInline = (text: string, keyBase: string): ReactNode[] => {
	const nodes: ReactNode[] = [];
	const re =
		/(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)\s]+\))/g;
	let last = 0;
	let i = 0;
	let m: RegExpExecArray | null;
	const key = () => `${keyBase}-i${i++}`;
	while ((m = re.exec(text))) {
		if (m.index > last) nodes.push(text.slice(last, m.index));
		const tok = m[0];
		if (tok.startsWith("`")) {
			nodes.push(
				<code key={key()} className={styles.code}>
					{tok.slice(1, -1)}
				</code>,
			);
		} else if (tok.startsWith("**") || tok.startsWith("__")) {
			nodes.push(
				<strong key={key()}>{renderInline(tok.slice(2, -2), key())}</strong>,
			);
		} else if (tok.startsWith("*") || tok.startsWith("_")) {
			nodes.push(
				<em key={key()}>{renderInline(tok.slice(1, -1), key())}</em>,
			);
		} else if (tok.startsWith("[")) {
			const mm = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(tok);
			if (mm && isSafeHref(mm[2])) {
				nodes.push(
					<a
						key={key()}
						href={mm[2]}
						target="_blank"
						rel="noreferrer noopener"
						className={styles.link}
					>
						{renderInline(mm[1], key())}
					</a>,
				);
			} else {
				nodes.push(tok);
			}
		}
		last = re.lastIndex;
	}
	if (last < text.length) nodes.push(text.slice(last));
	return nodes;
};

const isBullet = (l: string) => /^\s*[-*+]\s+/.test(l);
const isOrdered = (l: string) => /^\s*\d+[.)]\s+/.test(l);
const isHeading = (l: string) => /^#{1,6}\s+/.test(l);
const isQuote = (l: string) => /^\s*>\s?/.test(l);
const isHr = (l: string) => /^\s*([-*_])\s*(\1\s*){2,}$/.test(l);

export const Markdown = ({ text }: { text: string }) => {
	const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
	const blocks: ReactNode[] = [];
	let idx = 0;
	let b = 0;

	while (idx < lines.length) {
		const line = lines[idx];

		if (!line.trim()) {
			idx++;
			continue;
		}

		if (isHr(line)) {
			blocks.push(<hr key={`b${b++}`} className={styles.hr} />);
			idx++;
			continue;
		}

		const h = /^(#{1,6})\s+(.*)$/.exec(line);
		if (h) {
			const level = Math.min(h[1].length, 4);
			const bk = b++;
			const tag = `h${level}` as "h1" | "h2" | "h3" | "h4";
			blocks.push(
				createElement(
					tag,
					{ key: `b${bk}`, className: styles.heading, "data-level": level },
					renderInline(h[2].trim(), `h${bk}`),
				),
			);
			idx++;
			continue;
		}

		if (isQuote(line)) {
			const buf: string[] = [];
			while (idx < lines.length && isQuote(lines[idx])) {
				buf.push(lines[idx].replace(/^\s*>\s?/, ""));
				idx++;
			}
			blocks.push(
				<blockquote key={`b${b++}`} className={styles.quote}>
					{buf.map((l, i) => (
						<Fragment key={i}>
							{renderInline(l, `q${b}-${i}`)}
							{i < buf.length - 1 && <br />}
						</Fragment>
					))}
				</blockquote>,
			);
			continue;
		}

		if (isBullet(line) || isOrdered(line)) {
			const ordered = isOrdered(line);
			const items: string[] = [];
			while (
				idx < lines.length &&
				(ordered ? isOrdered(lines[idx]) : isBullet(lines[idx]))
			) {
				items.push(lines[idx].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""));
				idx++;
				while (
					idx < lines.length &&
					lines[idx].trim() &&
					!isBullet(lines[idx]) &&
					!isOrdered(lines[idx]) &&
					!isHeading(lines[idx]) &&
					!isQuote(lines[idx]) &&
					/^\s+\S/.test(lines[idx])
				) {
					items[items.length - 1] += ` ${lines[idx].trim()}`;
					idx++;
				}
			}
			const ListTag = ordered ? "ol" : "ul";
			blocks.push(
				<ListTag
					key={`b${b++}`}
					className={styles.list}
					data-ordered={ordered || undefined}
				>
					{items.map((it, i) => (
						<li key={i}>{renderInline(it, `li${b}-${i}`)}</li>
					))}
				</ListTag>,
			);
			continue;
		}
		const para: string[] = [];
		while (
			idx < lines.length &&
			lines[idx].trim() &&
			!isHeading(lines[idx]) &&
			!isBullet(lines[idx]) &&
			!isOrdered(lines[idx]) &&
			!isQuote(lines[idx]) &&
			!isHr(lines[idx])
		) {
			para.push(lines[idx]);
			idx++;
		}
		blocks.push(
			<p key={`b${b++}`} className={styles.p}>
				{para.map((l, i) => (
					<Fragment key={i}>
						{renderInline(l, `p${b}-${i}`)}
						{i < para.length - 1 && <br />}
					</Fragment>
				))}
			</p>,
		);
	}

	return <div className={styles.md}>{blocks}</div>;
};

export default Markdown;
