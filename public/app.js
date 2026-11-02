'use strict';
// Client-only enhancements. No secrets, user tokens, or privileged actions in browser code.
document.querySelectorAll('form').forEach(form=>{
  form.addEventListener('submit',()=>{
    const button=form.querySelector('button[type=submit],button:not([type])');
    if(button){button.disabled=true;button.dataset.original=button.textContent;button.textContent='Working…';}
  });
});
