import asyncio
from playwright.async_api import async_playwright
OUT="promo/caps/"  # run from the project root
async def union_clip(pg, sels, pad=16, max_h=None):
    boxes=[await pg.locator(s).first.bounding_box() for s in sels]
    x=min(b["x"] for b in boxes)-pad; y=min(b["y"] for b in boxes)-pad
    r=max(b["x"]+b["width"] for b in boxes)+pad; bt=max(b["y"]+b["height"] for b in boxes)+pad
    h=bt-y
    if max_h: h=min(h,max_h)
    return {"x":x,"y":y,"width":r-x,"height":h}
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={"width":860,"height":2400}, device_scale_factor=2); errs=[]
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto("http://localhost:8765/"); await pg.wait_for_function("window.xidid && window.xidid.state.snowballIndex")
        await pg.evaluate("document.fonts.ready"); await pg.wait_for_timeout(300)
        fam = await pg.evaluate("getComputedStyle(document.querySelector('h1')).fontFamily")
        ok = await pg.evaluate("document.fonts.check('600 40px Fraunces')")
        print("h1 font:", fam, "| Fraunces available:", ok)
        async def q(text, target=None, compare=True):
            if compare: await pg.check("#compare-toggle")
            else: await pg.uncheck("#compare-toggle")
            if target: await pg.select_option("#compare-target", target)
            await pg.fill("#search-input", text); await pg.click("#search-form button"); await pg.wait_for_timeout(200)
        await q("dugsi","raw")
        await pg.locator("#search-form").screenshot(path=OUT+"search_form.png")
        await pg.locator(".compare-col:last-child").screenshot(path=OUT+"raw_col.png")
        await pg.screenshot(path=OUT+"compare_dugsi.png", clip=await union_clip(pg, [".compare-summary",".compare-grid"], max_h=980))
        await q("dugsi", compare=False)
        await pg.locator("details.explain summary").first.click(); await pg.wait_for_timeout(200)
        await pg.locator(".result").first.screenshot(path=OUT+"explain.png")
        await pg.click("[data-tab=explorer]"); await pg.wait_for_timeout(200)
        await pg.screenshot(path=OUT+"figures.png", clip=await union_clip(pg, ["#conf-compare","#corpus-figures"]))
        await pg.click("[data-tab=search]"); await q("xaalad","snowball")
        await pg.screenshot(path=OUT+"compare_xaalad.png", clip=await union_clip(pg, [".compare-summary",".compare-grid"], max_h=760))
        print("errors:", errs); await b.close()
asyncio.run(main())
