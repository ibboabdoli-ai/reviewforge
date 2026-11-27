import {canViewUnit} from './access.mjs';

export async function reserveUnit({user,unit,start,end,reservations,quote}){
  if(!canViewUnit(user,unit))return {ok:false,reason:'forbidden'};
  if(reservations.some(r=>r.unitId===unit.id&&r.start<end&&start<r.end))
    return {ok:false,reason:'unavailable'};
  const price=await quote(unit,start,end);
  const reservation={unitId:unit.id,userId:user.id,start,end,price};
  reservations.push(reservation);
  return {ok:true,reservation};
}
