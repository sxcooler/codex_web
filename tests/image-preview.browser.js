async (page) => {
  await page.unrouteAll();
  await page.route('**/api/sessions/*/files/image?*', async route => {
    if(route.request().url().includes('path=broken.png'))return route.fulfill({status:404,body:'missing'});
    await route.fulfill({contentType:'image/png',path:'public/assets/icon-mobile-v1-512.png'});
  });
  for(const viewport of [{width:1280,height:900},{width:390,height:844}]) {
    await page.setViewportSize(viewport);
    await page.goto('http://127.0.0.1:4181/tests/workspace-panels.html?images=1');
    await page.waitForFunction(()=>!document.querySelector('#result').textContent.startsWith('RUNNING'));
    const result=await page.locator('#result').textContent();
    if(!result.startsWith('PASS'))throw new Error(result);
    console.log(viewport.width+': '+result);
  }
  await page.addStyleTag({url:'http://127.0.0.1:4181/src/web/style.css'});
  await page.getByRole('button',{name:'文件',exact:true}).click();
  await page.getByRole('button',{name:'photo.png',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.image-preview img')?.naturalWidth>0);
  await page.addStyleTag({content:'body{display:block;margin:0}#root{max-width:390px}#root>.markdown-message,#result{display:none}.git-panel{height:auto!important;max-height:none!important;width:100%;overflow:visible}.file-list{height:100px!important}.file-preview{margin:0}'});
  await page.locator('#right-sidebar').evaluate(el=>el.scrollTop=0);
  const bounds=await page.locator('.image-preview img').boundingBox();
  if(bounds.width>390)throw Error('Image exceeds mobile viewport');
  await page.locator('#right-sidebar').screenshot({path:'output/playwright/image-preview-mobile.png'});
  console.log('MOBILE_IMAGE_WIDTH='+bounds.width);
}
