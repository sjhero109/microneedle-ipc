"""매뉴얼 PDF 빌드: 목차를 만들고, 한 번 인쇄해 각 제목의 실제 쪽을 찾은 뒤 쪽 번호를 넣어 다시 인쇄한다."""
import re
import subprocess
import sys
import os
import pymupdf

SRC = sys.argv[1]          # manual.html
OUT = sys.argv[2]          # 최종 PDF
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PROFILE = os.path.join(os.environ["TEMP"], "manual-pdf-prof")
BUILD = SRC.replace(".html", ".build.html")

html = open(SRC, encoding="utf-8").read()

# 장과 절 목록
entries = []  # (kind, label, key, anchor)
sec_re = re.compile(r'<section class="chapter" id="(c\d)">([\s\S]*?)</section>')
h2_n = 0
def add_id(m):
    global h2_n
    h2_n += 1
    return f'<h2 id="h{h2_n}">'
for m in sec_re.finditer(html):
    cid, body = m.group(1), m.group(2)
    n = cid[1:]
    title = re.search(r'<h1>(.*?)</h1>', body).group(1)
    title = re.sub(r'<span class="role[^>]*>.*?</span>', '', title).strip()
    entries.append(("c", f"{n}", title, f"CHAPTER {n} ·", cid))
    for h in re.findall(r'<h2>(.*?)</h2>', body):
        text = re.sub(r'<[^>]+>', ' ', h)
        text = re.sub(r'\s+', ' ', text).strip()
        label = re.sub(r'\s*(작업자|관리자)$', '', text)
        num, _, rest = label.partition(' ')
        entries.append(("s", num, rest, label, None))

# 절 제목에 id 부여 (순서대로)
html_ids = re.sub(r'<h2>', add_id, html)

def toc_html(pages):
    out = []
    k = 0
    for kind, num, title, key, anchor in entries:
        pn = pages[k] if pages else "00"
        k += 1
        if kind == "c":
            out.append(f'<div class="c"><span class="n">{int(num):02d}</span><a href="#{anchor}">{title}</a><span class="fill"></span><span class="pn">{pn}</span></div>')
        else:
            out.append(f'<div class="s"><span>{num}</span><span>{title}</span><span class="fill"></span><span class="pn">{pn}</span></div>')
    return "\n    ".join(out)

def render(pages, path):
    doc = html_ids.replace("<!--TOC-->", toc_html(pages))
    open(BUILD, "w", encoding="utf-8").write(doc)
    url = "file:///" + BUILD.replace("\\", "/")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-first-run", f"--user-data-dir={PROFILE}",
                    "--no-pdf-header-footer", f"--print-to-pdf={path}", url],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def locate(path):
    d = pymupdf.open(path)
    texts = [re.sub(r"\s+", "", p.get_text()) for p in d]
    pages = []
    # 목차가 끝난 뒤(1장이 시작하는 쪽)부터 찾는다. 글자 간격 때문에 공백은 모두 빼고 비교한다
    start = next(i for i, t in enumerate(texts) if "CHAPTER1·" in t)
    for kind, num, title, key, anchor in entries:
        found = None
        k2 = re.sub(r"\s+", "", key)
        for i in range(start, len(texts)):
            if k2 in texts[i]:
                found = i
                break
        if found is None:
            raise SystemExit(f"제목을 찾지 못함: {key}")
        pages.append(found + 1)
        start = found
    return pages, len(texts)

tmp = OUT + ".pass1.pdf"
render(None, tmp)
pages, n1 = locate(tmp)
render(pages, OUT)
pages2, n2 = locate(OUT)
os.remove(tmp)
os.remove(BUILD)
if pages2 != pages:
    print("경고: 2차 인쇄에서 쪽이 바뀜", pages, pages2)
print("쪽 수", n2)
for (kind, num, title, key, anchor), p in zip(entries, pages2):
    print(("  " if kind == "s" else "") + f"{num} {title} .... {p}")
