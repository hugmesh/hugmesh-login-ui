/* tslint:disable */
/* eslint-disable */
import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { BaseService } from '../base-service';
import { ApiConfiguration } from '../api-configuration';
import { StrictHttpResponse } from '../strict-http-response';

import { AccountAppeal } from '../models/account-appeal';
import { accountAppealMine } from '../fn/account-appeal-user-controller/account-appeal-mine';
import { AccountAppealMine$Params } from '../fn/account-appeal-user-controller/account-appeal-mine';
import { accountAppealSubmit } from '../fn/account-appeal-user-controller/account-appeal-submit';
import { AccountAppealSubmit$Params } from '../fn/account-appeal-user-controller/account-appeal-submit';

@Injectable({ providedIn: 'root' })
export class AccountAppealUserControllerService extends BaseService {
  constructor(config: ApiConfiguration, http: HttpClient) {
    super(config, http);
  }

  /** Path part for operation `accountAppealMine()` */
  static readonly AccountAppealMinePath = '/bff/me/appeal';

  /**
   * My appeals.
   *
   *
   *
   * This method provides access to the full `HttpResponse`, allowing access to response headers.
   * To access only the response body, use `accountAppealMine()` instead.
   *
   * This method doesn't expect any request body.
   */
  accountAppealMine$Response(params?: AccountAppealMine$Params, context?: HttpContext): Observable<StrictHttpResponse<Array<AccountAppeal>>> {
    return accountAppealMine(this.http, this.rootUrl, params, context);
  }

  /**
   * My appeals.
   *
   *
   *
   * This method provides access only to the response body.
   * To access the full response (for headers, for example), `accountAppealMine$Response()` instead.
   *
   * This method doesn't expect any request body.
   */
  accountAppealMine(params?: AccountAppealMine$Params, context?: HttpContext): Observable<Array<AccountAppeal>> {
    return this.accountAppealMine$Response(params, context).pipe(
      map((r: StrictHttpResponse<Array<AccountAppeal>>): Array<AccountAppeal> => r.body)
    );
  }

  /** Path part for operation `accountAppealSubmit()` */
  static readonly AccountAppealSubmitPath = '/bff/me/appeal';

  /**
   * Submit appeal.
   *
   *
   *
   * This method provides access to the full `HttpResponse`, allowing access to response headers.
   * To access only the response body, use `accountAppealSubmit()` instead.
   *
   * This method sends `application/json` and handles request body of type `application/json`.
   */
  accountAppealSubmit$Response(params: AccountAppealSubmit$Params, context?: HttpContext): Observable<StrictHttpResponse<AccountAppeal>> {
    return accountAppealSubmit(this.http, this.rootUrl, params, context);
  }

  /**
   * Submit appeal.
   *
   *
   *
   * This method provides access only to the response body.
   * To access the full response (for headers, for example), `accountAppealSubmit$Response()` instead.
   *
   * This method sends `application/json` and handles request body of type `application/json`.
   */
  accountAppealSubmit(params: AccountAppealSubmit$Params, context?: HttpContext): Observable<AccountAppeal> {
    return this.accountAppealSubmit$Response(params, context).pipe(
      map((r: StrictHttpResponse<AccountAppeal>): AccountAppeal => r.body)
    );
  }

}
